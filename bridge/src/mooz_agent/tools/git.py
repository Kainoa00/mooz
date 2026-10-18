"""Read-only git: status, log, show, diff. No shell, no options from the model, no repo programs.

A repository's own config and attributes can make git run programs (filters, textconv,
external diff, fsmonitor). Every call neutralizes those, so asking about a repo can never
execute anything in it.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

from .files import FileAccessError, is_denied_name, resolve_inside
from .redact import redact

GIT_TIMEOUT = 5.0
MAX_OUTPUT_CHARS = 40_000
# Read at most this much of git's output before filtering and redacting it.
MAX_RAW_CHARS = 1_000_000
MAX_LOG = 20
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
_REF = re.compile(r"^(?!-)(?!.*\.\.)[A-Za-z0-9._/~^@{}-]{1,100}$")
_FILTER_KEY = re.compile(r"^filter\.(.+)\.(clean|smudge|process|required)$")


def _validate_ref(ref: str) -> str:
    if not _REF.match(ref):
        raise FileAccessError(f"{ref[:40]!r} is not a valid git ref")
    return ref


def _env() -> dict[str, str]:
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/nonexistent"),
        "LC_ALL": "C",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_OPTIONAL_LOCKS": "0",  # never write the index while reading
        "GIT_ATTR_SOURCE": EMPTY_TREE,  # ignore in-tree .gitattributes
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,  # and the repo's own config is neutralized below
    }


def _run(
    root: Path, args: list[str], *, safe_overrides: list[str]
) -> subprocess.CompletedProcess[str]:
    cmd = ["git", "-C", str(root), "--no-pager", *safe_overrides, *args]
    try:
        return subprocess.run(  # noqa: S603 - fixed argv, no shell
            cmd,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=GIT_TIMEOUT,
            stdin=subprocess.DEVNULL,
            env=_env(),
            check=False,
        )
    except subprocess.TimeoutExpired as err:
        raise FileAccessError("git took too long") from err
    except FileNotFoundError as err:
        raise FileAccessError("git is not installed on this machine") from err


def _filter_overrides(root: Path) -> list[str]:
    """Blank every configured filter driver (clean/smudge/process) for this call."""
    listing = _run(root, ["config", "--get-regexp", r"^filter\."], safe_overrides=[])
    drivers = sorted(
        {
            m.group(1)
            for line in listing.stdout.splitlines()
            if (m := _FILTER_KEY.match(line.split(" ", 1)[0]))
        }
    )
    out: list[str] = []
    for d in drivers:
        out += [
            "-c",
            f"filter.{d}.clean=",
            "-c",
            f"filter.{d}.smudge=",
            "-c",
            f"filter.{d}.process=",
        ]
        out += ["-c", f"filter.{d}.required=false"]
    return out


def _git(root: Path, *args: str, patch: bool = False) -> str:
    root = root.resolve()
    overrides = [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        *_filter_overrides(root),
    ]
    result = _run(root, list(args), safe_overrides=overrides)
    if result.returncode != 0:
        message = (result.stderr.strip().splitlines() or ["git failed"])[0]
        if "not a git repository" in message:
            raise FileAccessError("This source is not a git repository")
        raise FileAccessError("git: " + message.replace(str(root), ".").removeprefix("fatal: "))
    # Hide secrets files and redact before truncating: a cut can't split a secret, and
    # hidden files never use up the output budget.
    raw = result.stdout[:MAX_RAW_CHARS]
    out = redact(_hide_sensitive(raw) if patch else raw)
    if len(out) > MAX_OUTPUT_CHARS:
        out = out[:MAX_OUTPUT_CHARS] + "\n… output truncated"
    return out.rstrip() or "(no output)"


# A file section starts with its diff header; merges use the combined "--cc" form.
_SECTION = re.compile(r"^(?=diff --(?:git|cc|combined) )", re.MULTILINE)
_HUNK_OR_BINARY = re.compile(r"^(?:@@|Binary files |GIT binary patch)", re.MULTILINE)
_PATH_TOKENS = re.compile(r'[\s/"\\{}]+|=>')
_STAT_LINE = re.compile(r"^ (.+?) +\| ", re.MULTILINE)


def _mentions_denied(text: str) -> bool:
    return any(is_denied_name(t) for t in _PATH_TOKENS.split(text) if t)


def _hide_sensitive(patch: str) -> str:
    """Hide every file section (and stat line) that touches a secrets file, on either side.

    Pathspec excludes run before rename detection, so a .env renamed to settings.cfg would
    show up as a brand-new settings.cfg with the secrets in it. Instead git sees every path,
    pairs renames and copies, and each section is dropped if any path in its header (old,
    new, rename/copy from/to) is denied. Over-hiding a file is fine; leaking one is not.
    """
    parts = _SECTION.split(patch)
    preamble = _STAT_LINE.sub(
        lambda m: " (sensitive file) | " if _mentions_denied(m.group(1)) else m.group(0),
        parts[0],
    )
    out = [preamble]
    for section in parts[1:]:
        hunk = _HUNK_OR_BINARY.search(section)
        header = section[: hunk.start()] if hunk else section
        if _mentions_denied(header):
            out.append("(changes to a sensitive file are hidden)\n")
        else:
            out.append(section)
    return "".join(out)


def git_status(root: Path) -> str:
    return _git(root, "status", "--short", "--branch", "--no-renames")


def git_log(root: Path, path: str | None = None, n: int = 10) -> str:
    count = max(1, min(MAX_LOG, n))
    args = ["log", f"-n{count}", "--date=short", "--pretty=format:%h %ad %an %s", "--no-color"]
    if path:
        target = resolve_inside(root, path)
        # :(literal) so a file name can never be read as pathspec magic.
        args += ["--", ":(literal)" + target.relative_to(root.resolve()).as_posix()]
    return _git(root, *args)


_PATCH_FLAGS = (
    "--stat", "--patch", "--find-renames", "--find-copies", "--no-color", "--no-ext-diff",
    "--no-textconv",
)  # fmt: skip


def git_show(root: Path, ref: str = "HEAD") -> str:
    ref = _validate_ref(ref)
    return _git(root, "show", *_PATCH_FLAGS, ref, "--", ".", patch=True)


def git_diff(root: Path, ref_a: str | None = None, ref_b: str | None = None) -> str:
    refs = [_validate_ref(r) for r in (ref_a, ref_b) if r is not None]
    return _git(root, "diff", *_PATCH_FLAGS, *refs, "--", ".", patch=True)
