"""Read-only GitHub: issues, pull requests and CI checks, with the owner's own token.

The token (GITHUB_TOKEN; a fine-grained, read-only one is best) stays on the owner's machine
and never appears in output or errors. Everything the agent reads is redacted and capped,
and issue or PR text is untrusted data, like any file.
"""

from __future__ import annotations

import re
from typing import Any

import httpx

from .files import FileAccessError
from .redact import redact

API = "https://api.github.com"
TIMEOUT = 10.0
MAX_ITEMS = 20
MAX_COMMENTS = 10
MAX_FILES = 50
MAX_BODY_CHARS = 4000
MAX_OUTPUT_CHARS = 20_000
STATES = ("open", "closed", "all")

_REPO = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$")
_REF = re.compile(r"^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$")


_OPERATORS = frozenset({"AND", "OR", "NOT"})


def _plain_words(query: str) -> str:
    """Only plain words: search qualifiers (repo:, org:, in:…) and operators could widen a
    search beyond the one repository it's for."""
    words = []
    for token in query.split():
        if ":" in token:
            continue
        word = re.sub(r"[^\w.#+-]", "", token).lstrip("-")
        if word and word.upper() not in _OPERATORS:
            words.append(word)
    return " ".join(words[:12])


class GitHubError(FileAccessError):
    """A plain reason the agent couldn't read something on GitHub (never shows the token)."""


def valid_repo(repo: str) -> str:
    name = repo.split("/", 1)[-1]
    if not _REPO.match(repo) or name in (".", ".."):
        raise GitHubError(f"{repo[:60]!r} is not a GitHub repository (owner/name)")
    return repo


def _number(n: object) -> int:
    if isinstance(n, bool) or not isinstance(n, int) or n < 1:
        raise GitHubError("Issue and pull request numbers are whole numbers from 1 up")
    return n


def _state(state: str) -> str:
    if state not in STATES:
        raise GitHubError("state must be open, closed or all")
    return state


def _day(timestamp: object) -> str:
    return str(timestamp or "")[:10]


def _login(item: dict[str, Any]) -> str:
    return str((item.get("user") or {}).get("login") or "someone")


def _clip(text: object, limit: int = MAX_BODY_CHARS) -> str:
    body = str(text or "").strip()
    return body if len(body) <= limit else body[:limit] + " …"


def _done(text: str) -> str:
    text = redact(text)
    return text if len(text) <= MAX_OUTPUT_CHARS else text[:MAX_OUTPUT_CHARS] + "\n… truncated"


class GitHub:
    def __init__(self, token: str | None, *, base: str = API) -> None:
        headers = {
            "accept": "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "mooz-agent",
        }
        if token:
            headers["authorization"] = f"Bearer {token}"
        self._http = httpx.Client(base_url=base, headers=headers, timeout=TIMEOUT)

    def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        try:
            response = self._http.get(path, params=params)
        except httpx.HTTPError:
            raise GitHubError("Couldn't reach GitHub just now") from None
        if response.status_code == 401:
            raise GitHubError("GitHub rejected the token (check GITHUB_TOKEN)")
        limited = response.headers.get("x-ratelimit-remaining") == "0"
        if response.status_code == 429 or (response.status_code == 403 and limited):
            raise GitHubError("GitHub's rate limit is used up for now; try again later")
        if response.status_code in (403, 404):
            raise GitHubError(
                "No such repository, issue or pull request (or the token can't see it)"
            )
        if response.status_code >= 400:
            raise GitHubError(f"GitHub returned an error ({response.status_code})")
        return response.json()

    # -- issues ----------------------------------------------------------------------

    def issues(self, repo: str, state: str = "open", query: str | None = None) -> str:
        repo, state = valid_repo(repo), _state(state)
        query = _plain_words(query or "")
        if query:
            q = f"repo:{repo} is:issue"
            if state != "all":
                q += f" state:{state}"
            data = self._get("/search/issues", {"q": f"{q} {query}", "per_page": MAX_ITEMS})
            here = f"{API}/repos/{repo}".lower()
            items = [
                i for i in data.get("items", []) if str(i.get("repository_url", "")).lower() == here
            ]
        else:
            data = self._get(f"/repos/{repo}/issues", {"state": state, "per_page": MAX_ITEMS})
            items = [i for i in data if "pull_request" not in i]  # this API lists PRs too
        if not items:
            return f"No {'' if state == 'all' else state + ' '}issues" + (
                f" matching {query!r}." if query else "."
            )
        return _done("\n".join(self._issue_line(i) for i in items))

    @staticmethod
    def _issue_line(i: dict[str, Any]) -> str:
        labels = " ".join(str(label.get("name")) for label in i.get("labels") or [])
        return (
            f"#{i.get('number')} [{i.get('state')}] {i.get('title')} (by {_login(i)}, "
            f"{i.get('comments', 0)} comments, updated {_day(i.get('updated_at'))}) {labels}"
        ).rstrip()

    def issue(self, repo: str, number: int) -> str:
        repo, number = valid_repo(repo), _number(number)
        i = self._get(f"/repos/{repo}/issues/{number}")
        comments = self._get(f"/repos/{repo}/issues/{number}/comments", {"per_page": MAX_COMMENTS})
        lines = [self._issue_line(i), i.get("html_url", ""), "", _clip(i.get("body"))]
        if comments:
            lines += ["", f"Comments (first {MAX_COMMENTS}):"]
            lines += [
                f"{_login(c)} ({_day(c.get('created_at'))}): {_clip(c.get('body'), 1500)}"
                for c in comments
            ]
        return _done("\n".join(lines))

    # -- pull requests ---------------------------------------------------------------

    @staticmethod
    def _pull_line(p: dict[str, Any]) -> str:
        draft = ", draft" if p.get("draft") else ""
        head = (p.get("head") or {}).get("ref")
        base = (p.get("base") or {}).get("ref")
        return (
            f"#{p.get('number')} [{p.get('state')}] {p.get('title')} "
            f"(by {_login(p)}, {head} → {base}{draft})"
        )

    def pulls(self, repo: str, state: str = "open") -> str:
        repo, state = valid_repo(repo), _state(state)
        items = self._get(f"/repos/{repo}/pulls", {"state": state, "per_page": MAX_ITEMS})
        if not items:
            return f"No {'' if state == 'all' else state + ' '}pull requests."
        return _done("\n".join(self._pull_line(p) for p in items))

    def pull(self, repo: str, number: int) -> str:
        repo, number = valid_repo(repo), _number(number)
        p = self._get(f"/repos/{repo}/pulls/{number}")
        reviews = self._get(f"/repos/{repo}/pulls/{number}/reviews", {"per_page": MAX_ITEMS})
        changed = self._get(f"/repos/{repo}/pulls/{number}/files", {"per_page": MAX_FILES})
        merged = " (merged)" if p.get("merged") else ""
        lines = [
            self._pull_line(p) + merged,
            f"+{p.get('additions', 0)} -{p.get('deletions', 0)} "
            f"in {p.get('changed_files', 0)} files",
            "",
            _clip(p.get("body")),
        ]
        latest: dict[str, str] = {}
        for r in reviews:
            latest[_login(r)] = str(r.get("state", "")).lower().replace("_", " ")
        if latest:
            lines += ["", "Reviews: " + ", ".join(f"{who}: {s}" for who, s in latest.items())]
        if changed:
            lines += ["", "Files:"]
            lines += [
                f"{f.get('filename')} ({f.get('status')}, +{f.get('additions', 0)} "
                f"-{f.get('deletions', 0)})"
                for f in changed
            ]
        sha = (p.get("head") or {}).get("sha")
        if sha:
            lines += ["", self._checks(repo, str(sha), label=f"{str(sha)[:7]}")]
        return _done("\n".join(lines))

    # -- CI ----------------------------------------------------------------------------

    def ci(self, repo: str, ref: str | None = None) -> str:
        repo = valid_repo(repo)
        if ref is not None and not _REF.match(ref):
            raise GitHubError(f"{ref[:40]!r} is not a branch, tag or commit")
        if ref is None:
            ref = str(self._get(f"/repos/{repo}").get("default_branch") or "main")
        return _done(self._checks(repo, ref, label=ref))

    def _checks(self, repo: str, ref: str, *, label: str) -> str:
        data = self._get(f"/repos/{repo}/commits/{ref}/check-runs", {"per_page": 50})
        runs = data.get("check_runs", [])
        if not runs:
            return f"CI on {label}: no checks reported."
        counts = {"passed": 0, "failed": 0, "running": 0, "other": 0}
        lines = []
        for run in runs:
            status, conclusion = run.get("status"), run.get("conclusion")
            if status != "completed":
                counts["running"] += 1
                state = "in progress" if status == "in_progress" else str(status)
            elif conclusion in ("success", "skipped", "neutral"):
                counts["passed"] += 1
                state = str(conclusion)
            elif conclusion in ("failure", "timed_out", "cancelled", "action_required"):
                counts["failed"] += 1
                state = str(conclusion)
            else:
                counts["other"] += 1
                state = str(conclusion)
            lines.append(f"{run.get('name')}: {state}")
        summary = ", ".join(f"{n} {kind}" for kind, n in counts.items() if n)
        return "\n".join([f"CI on {label}: {summary}", *lines])
