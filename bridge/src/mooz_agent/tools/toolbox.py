"""The agent's tools, with access decided by who is asking.

The asker's identity comes from LiveKit (server-assigned, unforgeable). The owner sees every
source and their whole memory; anyone else sees only public sources and public notes, and can
never change memory. This is enforced here, in code, whatever the model is told or tricked into.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ..config import AgentConfig, GitHubRepo, Source
from ..memory import MemoryStore
from ..transcript import flatten
from . import files, git
from .files import FileAccessError
from .github import GitHub
from .redact import redact

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Scope:
    owner: bool
    asker_name: str


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]


@dataclass(frozen=True)
class ToolResult:
    content: str
    is_error: bool = False


class ToolArgumentError(Exception):
    pass


def _schema(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


def _text(args: dict[str, Any], key: str, *, required: bool = False) -> str | None:
    value = args.get(key)
    if value is None:
        if required:
            raise ToolArgumentError(f"{key} is required")
        return None
    if not isinstance(value, str) or (required and not value.strip()):
        raise ToolArgumentError(f"{key} must be a non-empty string")
    return value


def _int(args: dict[str, Any], key: str) -> int | None:
    value = args.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ToolArgumentError(f"{key} must be a whole number")
    return value


def _bool(args: dict[str, Any], key: str) -> bool:
    value = args.get(key)
    if value is None:
        return False
    if not isinstance(value, bool):
        raise ToolArgumentError(f"{key} must be true or false")
    return value


class ToolBox:
    def __init__(
        self,
        config: AgentConfig,
        memory: MemoryStore | None,
        *,
        owner_name: str,
        github: GitHub | None = None,
    ) -> None:
        self.config = config
        self.memory = memory
        self.owner_name = owner_name
        self.github = github
        self._handlers: dict[str, Callable[[dict[str, Any], Scope], str]] = {
            "list_files": self._list_files,
            "read_file": self._read_file,
            "search": self._search,
            "git_status": self._git_status,
            "git_log": self._git_log,
            "git_show": self._git_show,
            "git_diff": self._git_diff,
            "github_issues": self._github_issues,
            "github_issue": self._github_issue,
            "github_pulls": self._github_pulls,
            "github_pull": self._github_pull,
            "github_ci": self._github_ci,
            "recall": self._recall,
            "remember": self._remember,
            "forget": self._forget,
        }

    # -- what the model is offered -------------------------------------------------

    def _visible(self, scope: Scope) -> list[Source]:
        return self.config.visible_sources(owner=scope.owner)

    def _visible_github(self, scope: Scope) -> list[GitHubRepo]:
        return self.config.visible_github(owner=scope.owner)

    def sources_summary(self, scope: Scope) -> str:
        sources = self._visible(scope)
        repos = self._visible_github(scope)
        if not sources and not repos:
            return "You have no folders or repositories you can read for this person."
        parts = []
        if sources:
            listed = ", ".join(s.label for s in sources)
            parts.append(f"Folders and repositories you can read for this person: {listed}.")
        if repos:
            listed = ", ".join(f"{g.label} ({g.repo})" for g in repos)
            parts.append(
                f"GitHub repositories (issues, pull requests, CI) for this person: {listed}."
            )
        return " ".join(parts)

    def specs(self, scope: Scope) -> list[ToolSpec]:
        out: list[ToolSpec] = []
        labels = [s.label for s in self._visible(scope)]
        if labels:
            source = {"type": "string", "enum": labels, "description": "Which folder or repository"}
            path = {"type": "string", "description": "Path relative to the source, e.g. src/app.py"}
            out += [
                ToolSpec(
                    "list_files",
                    "List a folder in a source, or find files by glob pattern (e.g. **/*.py).",
                    _schema(
                        {"source": source, "path": path, "pattern": {"type": "string"}}, ["source"]
                    ),
                ),
                ToolSpec(
                    "read_file",
                    "Read a text file from a source (numbered lines; long files in parts).",
                    _schema(
                        {
                            "source": source,
                            "path": path,
                            "start_line": {"type": "integer"},
                            "end_line": {"type": "integer"},
                        },
                        ["source", "path"],
                    ),
                ),
                ToolSpec(
                    "search",
                    "Search file contents (case-insensitive). Omit source to search all of them.",
                    _schema(
                        {
                            "query": {"type": "string"},
                            "source": source,
                            "path": path,
                            "regex": {"type": "boolean"},
                        },
                        ["query"],
                    ),
                ),
                ToolSpec(
                    "git_status",
                    "Current branch and uncommitted changes.",
                    _schema({"source": source}, ["source"]),
                ),
                ToolSpec(
                    "git_log",
                    "Recent commits, optionally for one path.",
                    _schema({"source": source, "path": path, "n": {"type": "integer"}}, ["source"]),
                ),
                ToolSpec(
                    "git_show",
                    "Show one commit (message and changes).",
                    _schema({"source": source, "ref": {"type": "string"}}, ["source"]),
                ),
                ToolSpec(
                    "git_diff",
                    "Uncommitted changes, or the difference between two refs.",
                    _schema(
                        {
                            "source": source,
                            "ref_a": {"type": "string"},
                            "ref_b": {"type": "string"},
                        },
                        ["source"],
                    ),
                ),
            ]
        repos = [g.label for g in self._visible_github(scope)]
        if repos:
            gh = {"type": "string", "enum": repos, "description": "Which GitHub repository"}
            state = {"type": "string", "enum": ["open", "closed", "all"]}
            number = {"type": "integer", "description": "Issue or pull request number"}
            out += [
                ToolSpec(
                    "github_issues",
                    "List a GitHub repository's issues, optionally matching some text.",
                    _schema(
                        {"source": gh, "state": state, "query": {"type": "string"}}, ["source"]
                    ),
                ),
                ToolSpec(
                    "github_issue",
                    "Read one GitHub issue with its first comments.",
                    _schema({"source": gh, "number": number}, ["source", "number"]),
                ),
                ToolSpec(
                    "github_pulls",
                    "List a GitHub repository's pull requests.",
                    _schema({"source": gh, "state": state}, ["source"]),
                ),
                ToolSpec(
                    "github_pull",
                    "Read one pull request: description, reviews, changed files and CI checks.",
                    _schema({"source": gh, "number": number}, ["source", "number"]),
                ),
                ToolSpec(
                    "github_ci",
                    "CI check results for a branch, tag or commit (default branch if omitted).",
                    _schema({"source": gh, "ref": {"type": "string"}}, ["source"]),
                ),
            ]
        if self.memory is not None:
            out.append(
                ToolSpec(
                    "recall",
                    "Search your long-term memory of things you were told to remember.",
                    _schema({"query": {"type": "string"}}, ["query"]),
                )
            )
            if scope.owner:
                out += [
                    ToolSpec(
                        "remember",
                        "Save a note to long-term memory when your owner asks you to remember "
                        "something. Private unless they say anyone may know it.",
                        _schema(
                            {"note": {"type": "string"}, "public": {"type": "boolean"}}, ["note"]
                        ),
                    ),
                    ToolSpec(
                        "forget",
                        "Delete a memory note by its id when your owner asks.",
                        _schema({"id": {"type": "string"}}, ["id"]),
                    ),
                ]
        return out

    # -- describing a call (task progress, built from the arguments, never model prose) -

    def describe(self, name: str, args: dict[str, Any]) -> str:
        def arg(key: str, default: str = "") -> str:
            value = args.get(key)
            text = value if isinstance(value, str) and value.strip() else default
            return redact(flatten(text))[:60]

        def number() -> str:
            value = args.get("number")
            return str(value) if isinstance(value, int) and not isinstance(value, bool) else "?"

        source = arg("source", "your sources")
        descriptions: dict[str, Callable[[], str]] = {
            "list_files": lambda: f"Listing {arg('path', 'files')} in {source}",
            "read_file": lambda: f"Reading {arg('path')} in {source}",
            "search": lambda: f"Searching {source} for '{arg('query')}'",
            "git_status": lambda: f"Checking git status of {source}",
            "git_log": lambda: f"Reading the history of {source}",
            "git_show": lambda: f"Looking at commit {arg('ref', 'HEAD')} in {source}",
            "git_diff": lambda: f"Comparing changes in {source}",
            "github_issues": lambda: f"Checking issues in {source}",
            "github_issue": lambda: f"Reading issue #{number()} in {source}",
            "github_pulls": lambda: f"Checking pull requests in {source}",
            "github_pull": lambda: f"Reading PR #{number()} in {source}",
            "github_ci": lambda: f"Checking CI on {arg('ref', 'the default branch')} in {source}",
            "recall": lambda: f"Checking my memory for '{arg('query')}'",
            "remember": lambda: "Updating my memory",
            "forget": lambda: "Updating my memory",
        }
        describe = descriptions.get(name)
        return describe() if describe else "Working"

    # -- running a call ------------------------------------------------------------

    def dispatch(self, name: str, args: dict[str, Any], scope: Scope) -> ToolResult:
        handler = self._handlers.get(name)
        if handler is None:
            return ToolResult(f"Unknown tool {name!r}", is_error=True)
        if not isinstance(args, dict):
            return ToolResult("Tool arguments must be an object", is_error=True)
        try:
            return ToolResult(handler(args, scope))
        except (ToolArgumentError, FileAccessError, ValueError) as err:
            return ToolResult(str(err), is_error=True)
        except Exception:
            log.exception("tool %s failed", name)
            return ToolResult(f"{name} failed unexpectedly", is_error=True)

    def _source(self, args: dict[str, Any], scope: Scope) -> Source:
        label = _text(args, "source", required=True)
        for source in self._visible(scope):
            if source.label == label:
                return source
        # Private sources and missing ones are indistinguishable to non-owners.
        raise FileAccessError(f"No source called {label!r}")

    def _list_files(self, args: dict[str, Any], scope: Scope) -> str:
        source = self._source(args, scope)
        return files.list_files(source.path, _text(args, "path") or ".", _text(args, "pattern"))

    def _read_file(self, args: dict[str, Any], scope: Scope) -> str:
        source = self._source(args, scope)
        path = _text(args, "path", required=True)
        assert path is not None
        return files.read_file(
            source.path, path, _int(args, "start_line") or 1, _int(args, "end_line")
        )

    def _search(self, args: dict[str, Any], scope: Scope) -> str:
        query = _text(args, "query", required=True)
        assert query is not None
        regex = _bool(args, "regex")
        path = _text(args, "path") or "."
        targets = (
            [self._source(args, scope)] if args.get("source") is not None else self._visible(scope)
        )
        if not targets:
            raise FileAccessError("There are no folders to search")
        results = []
        for source in targets:
            out = files.search(source.path, query, path=path, regex=regex)
            if not out.startswith("No matches"):
                results.append("\n".join(f"[{source.label}] {line}" for line in out.splitlines()))
        return "\n".join(results) if results else f"No matches for {query!r}"

    def _git_status(self, args: dict[str, Any], scope: Scope) -> str:
        return git.git_status(self._source(args, scope).path)

    def _git_log(self, args: dict[str, Any], scope: Scope) -> str:
        source = self._source(args, scope)
        return git.git_log(source.path, _text(args, "path"), _int(args, "n") or 10)

    def _git_show(self, args: dict[str, Any], scope: Scope) -> str:
        source = self._source(args, scope)
        return git.git_show(source.path, _text(args, "ref") or "HEAD")

    def _git_diff(self, args: dict[str, Any], scope: Scope) -> str:
        source = self._source(args, scope)
        return git.git_diff(source.path, _text(args, "ref_a"), _text(args, "ref_b"))

    def _repo(self, args: dict[str, Any], scope: Scope) -> str:
        label = _text(args, "source", required=True)
        for repo in self._visible_github(scope):
            if repo.label == label:
                if self.github is None:
                    raise FileAccessError("GitHub isn't set up for this agent")
                return repo.repo
        # Private repos and missing ones are indistinguishable to non-owners.
        raise FileAccessError(f"No source called {label!r}")

    def _github_client(self) -> GitHub:
        assert self.github is not None
        return self.github

    def _github_issues(self, args: dict[str, Any], scope: Scope) -> str:
        repo = self._repo(args, scope)
        return self._github_client().issues(
            repo, _text(args, "state") or "open", _text(args, "query")
        )

    def _github_issue(self, args: dict[str, Any], scope: Scope) -> str:
        repo = self._repo(args, scope)
        return self._github_client().issue(repo, _int(args, "number") or 0)

    def _github_pulls(self, args: dict[str, Any], scope: Scope) -> str:
        repo = self._repo(args, scope)
        return self._github_client().pulls(repo, _text(args, "state") or "open")

    def _github_pull(self, args: dict[str, Any], scope: Scope) -> str:
        repo = self._repo(args, scope)
        return self._github_client().pull(repo, _int(args, "number") or 0)

    def _github_ci(self, args: dict[str, Any], scope: Scope) -> str:
        repo = self._repo(args, scope)
        return self._github_client().ci(repo, _text(args, "ref"))

    def _memory(self) -> MemoryStore:
        if self.memory is None:
            raise ToolArgumentError("Memory is not enabled for this agent")
        return self.memory

    def _recall(self, args: dict[str, Any], scope: Scope) -> str:
        query = _text(args, "query", required=True)
        assert query is not None
        notes = self._memory().recall(query, owner=scope.owner)
        if not notes:
            return "Nothing in memory about that."
        return "\n".join(f"[{n.id}] {n.text}" for n in notes)

    def _require_owner(self, scope: Scope) -> None:
        if not scope.owner:
            raise ToolArgumentError(f"Only {self.owner_name} can change my memory")

    def _remember(self, args: dict[str, Any], scope: Scope) -> str:
        self._require_owner(scope)
        note = _text(args, "note", required=True)
        assert note is not None
        saved = self._memory().remember(note, public=_bool(args, "public"))
        return f"Remembered {'(public) ' if saved.public else ''}{saved.id}"

    def _forget(self, args: dict[str, Any], scope: Scope) -> str:
        self._require_owner(scope)
        note_id = _text(args, "id", required=True)
        assert note_id is not None
        if not self._memory().forget(note_id):
            raise ToolArgumentError(f"No memory note {note_id}")
        return f"Forgot {note_id}"
