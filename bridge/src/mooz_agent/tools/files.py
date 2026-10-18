"""Read-only file access inside a source folder: list, read, search.

Every path is resolved (following symlinks) and must stay inside the source. Secrets files,
VCS internals and vendored folders are invisible. All output is redacted.
"""

from __future__ import annotations

import fnmatch
import os
import time
from collections.abc import Callable, Iterator
from pathlib import Path

import regex

from ..config import agents_root
from .redact import redact

MAX_LINES = 400
MAX_READ_BYTES = 64_000
MAX_FILE_BYTES = 5_000_000
MAX_SEARCH_FILE_BYTES = 1_000_000
MAX_SEARCH_FILES = 5_000
SEARCH_SECONDS = 3.0
MAX_LINE_CHARS = 300
# The stdlib `re` can't be interrupted, so a pattern like (a|aa)+$ could hang the agent.
# Regex search uses the `regex` module with a hard per-line timeout instead.
REGEX_LINE_TIMEOUT = 0.05
MAX_LIST_FILES = 20_000
LIST_SECONDS = 3.0

DENIED_FILES = (
    ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.keystore", "*.jks",
    "id_rsa*", "id_dsa*", "id_ecdsa*", "id_ed25519*", ".netrc", ".npmrc", ".pypirc",
    ".git-credentials", "*credentials*", ".htpasswd",
    "memory.jsonl", "agent.toml",  # an agent's own memory and settings, wherever they are
)  # fmt: skip
# .mooz holds agents' own settings and private memory.
DENIED_DIRS = frozenset({".ssh", ".gnupg", ".aws", ".git", ".hg", ".svn", ".mooz"})
VENDORED_DIRS = frozenset(
    {"node_modules", ".venv", "venv", "__pycache__", ".next", ".mypy_cache", ".pytest_cache",
     ".ruff_cache", "dist", "build", "target", ".tox", ".cache"}
)  # fmt: skip
HIDDEN_DIRS = DENIED_DIRS | VENDORED_DIRS


class FileAccessError(Exception):
    """A safe, user-facing reason the agent can't read something (never reveals real paths)."""


def is_denied_name(name: str) -> bool:
    return name in HIDDEN_DIRS or any(fnmatch.fnmatch(name, p) for p in DENIED_FILES)


def _visible(root: Path, path: Path) -> bool:
    """True if `path` (already resolved) is inside `root` and nothing on the way is denied."""
    if not path.is_relative_to(root):
        return False
    # Agents' settings and memory, wherever MOOZ_HOME puts them (not only in a .mooz folder).
    if path.is_relative_to(agents_root().resolve()):
        return False
    return not any(is_denied_name(part) for part in path.relative_to(root).parts)


def resolve_inside(root: Path, rel: str) -> Path:
    """Resolve `rel` inside `root`, refusing anything outside it or on the deny list."""
    if rel.startswith("~") or Path(rel).is_absolute():
        raise FileAccessError("Paths are relative to the source folder")
    root = root.resolve()
    candidate = (root / rel).resolve()
    if not candidate.is_relative_to(root):
        raise FileAccessError("That path is outside this source")
    lexical = Path(os.path.normpath(rel)).parts
    if not _visible(root, candidate) or any(is_denied_name(p) for p in lexical):
        raise FileAccessError("That file is not available")
    return candidate


def _rel(root: Path, path: Path) -> str:
    return path.relative_to(root.resolve()).as_posix()


def _walk(root: Path, base: Path, deadline: float | None = None) -> Iterator[Path]:
    """Visible files under `base`, never following links out of `root`."""
    root = root.resolve()
    for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
        if deadline is not None and time.monotonic() > deadline:
            return
        here = Path(dirpath)
        dirnames[:] = sorted(
            d for d in dirnames if not is_denied_name(d) and not (here / d).is_symlink()
        )
        for name in sorted(filenames):
            if is_denied_name(name):
                continue
            path = here / name
            resolved = path.resolve()
            if resolved.is_file() and _visible(root, resolved):
                yield path


def _capped(lines: list[str], limit: int, what: str) -> str:
    if len(lines) <= limit:
        return "\n".join(lines)
    return "\n".join([*lines[:limit], f"… {len(lines) - limit} more {what}"])


def list_files(root: Path, path: str = ".", pattern: str | None = None, limit: int = 200) -> str:
    base = resolve_inside(root, path)
    if not base.is_dir():
        raise FileAccessError(f"{path} is not a folder")
    if pattern:
        tail = pattern[3:] if pattern.startswith("**/") else None
        hits = []
        deadline = time.monotonic() + LIST_SECONDS
        for i, p in enumerate(_walk(root, base, deadline)):
            if i >= MAX_LIST_FILES:
                break
            rel = _rel(root, p)
            if fnmatch.fnmatch(rel, pattern) or (tail and fnmatch.fnmatch(p.name, tail)):
                hits.append(rel)
        return redact(_capped(hits, limit, "files")) if hits else f"No files match {pattern!r}"
    entries = []
    resolved_root = root.resolve()
    for child in sorted(base.iterdir(), key=lambda p: p.name):
        if is_denied_name(child.name):
            continue
        target = child.resolve()
        if not _visible(resolved_root, target):
            continue
        entries.append(child.name + ("/" if target.is_dir() else ""))
    return redact(_capped(entries, limit, "entries")) if entries else "(empty folder)"


def _read_text(path: Path, shown: str) -> str:
    if not path.exists():
        raise FileAccessError(f"No such file: {shown}")
    if path.is_dir():
        raise FileAccessError(f"{shown} is a folder; list it instead")
    if not path.is_file():  # a pipe or device would block forever
        raise FileAccessError(f"{shown} is not a regular file")
    if path.stat().st_size > MAX_FILE_BYTES:
        raise FileAccessError(f"{shown} is too large to read")
    data = path.read_bytes()
    if b"\0" in data[:8192]:
        raise FileAccessError(f"{shown} is a binary file")
    return data.decode("utf-8", errors="replace")


def read_file(root: Path, path: str, start_line: int = 1, end_line: int | None = None) -> str:
    target = resolve_inside(root, path)
    shown = _rel(root, target)
    # Redact the whole file first: a line range could start in the middle of a secret.
    lines = redact(_read_text(target, shown)).splitlines()
    total = len(lines)
    start = max(1, start_line)
    if total and start > total:
        raise FileAccessError(f"{shown} has only {total} lines")
    end = min(total, end_line if end_line is not None else start + MAX_LINES - 1)
    end = min(end, start + MAX_LINES - 1)
    out: list[str] = []
    size = 0
    last = start - 1
    for number in range(start, end + 1):
        line = f"{number:>4}  {lines[number - 1]}"
        size += len(line) + 1
        if size > MAX_READ_BYTES:
            break
        out.append(line)
        last = number
    header = f"{shown} (lines {start}-{last} of {total})" if total else f"{shown} (empty file)"
    footer = [f"… {total - last} more lines (ask for lines {last + 1}+)"] if last < total else []
    return "\n".join([header, *out, *footer])


def _matcher(query: str, *, regex_mode: bool) -> Callable[[str], bool]:
    if not regex_mode:
        needle = query.casefold()
        return lambda line: needle in line.casefold()
    try:
        compiled = regex.compile(query, regex.IGNORECASE)
    except regex.error as err:
        raise FileAccessError(f"Not a valid regular expression: {err}") from err
    return lambda line: compiled.search(line, timeout=REGEX_LINE_TIMEOUT) is not None


def search(root: Path, query: str, path: str = ".", regex: bool = False, limit: int = 50) -> str:
    base = resolve_inside(root, path)
    matches = _matcher(query, regex_mode=regex)
    deadline = time.monotonic() + SEARCH_SECONDS
    hits: list[str] = []
    more = False
    files = [base] if base.is_file() else _walk(root, base)
    for i, file in enumerate(files):
        if i >= MAX_SEARCH_FILES or time.monotonic() > deadline:
            more = True
            break
        try:
            if file.stat().st_size > MAX_SEARCH_FILE_BYTES:
                continue
            # Search the redacted text, so a query can't confirm what a secret is.
            text = redact(_read_text(file, ""))
        except (FileAccessError, OSError):
            continue
        for number, line in enumerate(text.splitlines(), 1):
            try:
                hit = matches(line)
            except TimeoutError:
                raise FileAccessError(
                    "That regular expression is too slow to run; try a simpler one"
                ) from None
            if hit:
                if len(hits) >= limit:
                    more = True
                    break
                hits.append(f"{_rel(root, file)}:{number}: {line[:MAX_LINE_CHARS]}")
        if more:
            break
    if not hits:
        return f"No matches for {query!r}"
    if more:
        hits.append("… more matches; narrow the search with a path or a more specific query")
    return redact("\n".join(hits))
