import subprocess
from pathlib import Path

import pytest

from mooz_agent.tools.files import FileAccessError
from mooz_agent.tools.git import git_diff, git_log, git_show, git_status

pytestmark = pytest.mark.unit


def run(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=Kai", "-c", "user.email=k@example.com", *args],
        cwd=root, check=True, capture_output=True, text=True,
    ).stdout.strip()  # fmt: skip


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    run(root, "init", "-q", "-b", "main")
    (root / "app.py").write_text("print('v1')\n")
    (root / ".env").write_text("TOKEN=supersecretvalue123\n")
    run(root, "add", "-A")
    run(root, "commit", "-q", "-m", "first: add app")
    (root / "app.py").write_text("print('v2')\n")
    (root / ".env").write_text("TOKEN=rotatedsecretvalue456\n")
    run(root, "commit", "-q", "-am", "second: bump app")
    (root / "app.py").write_text("print('v3 uncommitted')\n")
    return root


def test_status_shows_branch_and_changes(repo: Path) -> None:
    out = git_status(repo)

    assert "## main" in out
    assert "M app.py" in out


def test_log_lists_recent_commits(repo: Path) -> None:
    lines = git_log(repo).splitlines()

    assert len(lines) == 2
    assert lines[0].endswith("Kai second: bump app")


def test_log_for_a_path_and_capped_count(repo: Path) -> None:
    assert len(git_log(repo, path="app.py", n=1).splitlines()) == 1
    assert len(git_log(repo, n=999).splitlines()) == 2  # clamped, not an error


def test_show_a_commit_without_denied_files(repo: Path) -> None:
    head = run(repo, "rev-parse", "--short", "HEAD")

    out = git_show(repo, head)

    assert "second: bump app" in out
    assert "+print('v2')" in out
    assert ".env" not in out and "secretvalue" not in out


def test_diff_working_tree_and_between_refs(repo: Path) -> None:
    assert "+print('v3 uncommitted')" in git_diff(repo)
    between = git_diff(repo, "HEAD~1", "HEAD")
    assert "+print('v2')" in between
    assert "secretvalue" not in between


@pytest.mark.parametrize(
    "ref",
    ["--output=/tmp/pwned", "-p", "--ext-diff", "HEAD;rm -rf /", "$(id)", "a b", "", "x" * 200],
)
def test_rejects_refs_that_could_be_options_or_injections(repo: Path, ref: str) -> None:
    with pytest.raises(FileAccessError, match="ref"):
        git_show(repo, ref)
    with pytest.raises(FileAccessError, match="ref"):
        git_diff(repo, ref)


def test_unknown_ref_is_a_clear_error_without_paths(repo: Path) -> None:
    with pytest.raises(FileAccessError) as exc:
        git_show(repo, "does-not-exist")

    assert str(repo) not in str(exc.value)


def test_log_path_must_stay_inside_and_be_allowed(repo: Path) -> None:
    with pytest.raises(FileAccessError):
        git_log(repo, path="../x")
    with pytest.raises(FileAccessError, match="not available"):
        git_log(repo, path=".env")


def test_non_repo_source(tmp_path: Path) -> None:
    with pytest.raises(FileAccessError, match="not a git repository"):
        git_status(tmp_path)


def test_repo_config_cannot_run_external_programs(repo: Path, tmp_path: Path) -> None:
    marker = tmp_path / "ran"
    run(repo, "config", "diff.external", f"sh -c 'touch {marker}'")
    run(repo, "config", "core.fsmonitor", f"sh -c 'touch {marker}'")
    (repo / ".gitattributes").write_text("*.py diff=evil\n")
    run(repo, "config", "diff.evil.textconv", f"sh -c 'touch {marker}; cat'")

    git_diff(repo)
    git_show(repo, "HEAD")
    git_status(repo)

    assert not marker.exists()


def test_filters_from_repo_attributes_never_run(repo: Path, tmp_path: Path) -> None:
    marker = tmp_path / "filter-ran"
    (repo / ".git" / "info").mkdir(exist_ok=True)
    (repo / ".git" / "info" / "attributes").write_text("* filter=evil\n")
    (repo / ".gitattributes").write_text("* filter=evil2\n")
    run(repo, "config", "filter.evil.clean", f"sh -c 'touch {marker}; cat'")
    run(repo, "config", "filter.evil2.clean", f"sh -c 'touch {marker}; cat'")
    (repo / "app.py").write_text("print('changed again')\n")

    git_status(repo)
    git_diff(repo)

    assert not marker.exists()


def test_git_never_writes_the_index(repo: Path) -> None:
    index = repo / ".git" / "index"
    before = index.stat().st_mtime_ns

    git_status(repo)
    git_diff(repo)

    assert index.stat().st_mtime_ns == before
