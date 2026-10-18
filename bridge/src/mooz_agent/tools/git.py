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

from .files import DENIED_DIRS, DENIED_FILES, FileAccessError, resolve_inside
from .redact import redact

GIT_TIMEOUT = 5.0
MAX_OUTPUT_CHARS = 40_000
MAX_LOG = 20
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
_REF = re.compile(r"^(?!-)(?!.*\.\.)[A-Za-z0-9._/~^@{}-]{1,100}$")
_FILTER_KEY = re.compile(r"^filter\.(.+)\.(clean|smudge|process|required)$")

# Keep secrets files out of diffs and patches, on top of output redaction.
_EXCLUDES = [f":(exclude,glob)**/{p}" for p in DENIED_FILES] + [
    f":(exclude,glob)**/{d}/**" for d in sorted(DENIED_DIRS)
]


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


def _git(root: Path, *args: str) -> str:
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
    out = result.stdout
    if len(out) > MAX_OUTPUT_CHARS:
        out = out[:MAX_OUTPUT_CHARS] + "\n… output truncated"
    return redact(out.rstrip()) or "(no output)"


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


def git_show(root: Path, ref: str = "HEAD") -> str:
    ref = _validate_ref(ref)
    return _git(
        root, "show", "--stat", "--patch", "--no-color", "--no-ext-diff", "--no-textconv",
        ref, "--", ".", *_EXCLUDES,
    )  # fmt: skip


def git_diff(root: Path, ref_a: str | None = None, ref_b: str | None = None) -> str:
    refs = [_validate_ref(r) for r in (ref_a, ref_b) if r is not None]
    return _git(
        root, "diff", "--stat", "--patch", "--no-color", "--no-ext-diff", "--no-textconv",
        *refs, "--", ".", *_EXCLUDES,
    )  # fmt: skip
