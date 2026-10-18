import os
from pathlib import Path

import pytest

from mooz_agent.tools.files import (
    MAX_LINES,
    FileAccessError,
    list_files,
    read_file,
    resolve_inside,
    search,
)

pytestmark = pytest.mark.unit


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    (root / "src").mkdir(parents=True)
    (root / "src" / "app.py").write_text("def main():\n    return 'deploy'\n")
    (root / "README.md").write_text("# Demo\nThe deploy is blocked on the migration.\n")
    (root / ".env").write_text("ANTHROPIC_API_KEY=sk-ant-" + "x" * 40 + "\n")
    (root / ".env.production").write_text("SECRET=1\n")
    (root / "server.pem").write_text("-----BEGIN PRIVATE KEY-----\n")
    (root / ".ssh").mkdir()
    (root / ".ssh" / "config").write_text("Host x\n")
    (root / "node_modules" / "lib").mkdir(parents=True)
    (root / "node_modules" / "lib" / "index.js").write_text("deploy\n")
    (root / ".git").mkdir()
    (root / ".git" / "config").write_text("[core]\n")
    (root / "logo.png").write_bytes(b"\x89PNG\x00\x00binary")
    (root / "config.py").write_text('API_KEY = "abcdefgh12345678"\n')
    outside = tmp_path / "outside.txt"
    outside.write_text("private stuff\n")
    (root / "link-out").symlink_to(outside)
    (root / "src" / "link-in").symlink_to(root / "README.md")
    return root


class TestResolveInside:
    def test_relative_paths_resolve_within_the_source(self, repo: Path) -> None:
        assert resolve_inside(repo, "src/app.py") == (repo / "src" / "app.py").resolve()

    @pytest.mark.parametrize(
        "path", ["../outside.txt", "src/../../outside.txt", "/etc/passwd", "~/x"]
    )
    def test_rejects_escapes_and_absolute_paths(self, repo: Path, path: str) -> None:
        with pytest.raises(FileAccessError):
            resolve_inside(repo, path)

    def test_rejects_symlinks_that_point_outside(self, repo: Path) -> None:
        with pytest.raises(FileAccessError):
            resolve_inside(repo, "link-out")

    def test_allows_symlinks_that_stay_inside(self, repo: Path) -> None:
        assert resolve_inside(repo, "src/link-in") == (repo / "README.md").resolve()

    @pytest.mark.parametrize(
        "path",
        [
            ".env",
            ".env.production",
            "server.pem",
            ".ssh/config",
            ".git/config",
            "node_modules/lib/index.js",
        ],
    )
    def test_denied_and_internal_files_are_not_available(self, repo: Path, path: str) -> None:
        with pytest.raises(FileAccessError, match="not available"):
            resolve_inside(repo, path)

    def test_errors_never_reveal_absolute_paths(self, repo: Path) -> None:
        with pytest.raises(FileAccessError) as exc:
            resolve_inside(repo, "../outside.txt")
        assert str(repo) not in str(exc.value)


class TestListFiles:
    def test_lists_a_folder_without_denied_or_vendored_entries(self, repo: Path) -> None:
        out = list_files(repo)

        lines = out.splitlines()
        assert "README.md" in lines and "src/" in lines and "config.py" in lines
        for hidden in [
            ".env",
            ".env.production",
            "server.pem",
            ".ssh/",
            "node_modules/",
            ".git/",
            "link-out",
        ]:
            assert hidden not in lines

    def test_glob_patterns_search_recursively(self, repo: Path) -> None:
        assert list_files(repo, pattern="**/*.py").splitlines() == ["config.py", "src/app.py"]

    def test_listing_a_subfolder(self, repo: Path) -> None:
        assert "app.py" in list_files(repo, "src").splitlines()

    def test_listing_is_capped(self, repo: Path) -> None:
        for i in range(30):
            (repo / f"f{i:02}.txt").write_text("x")

        out = list_files(repo, limit=10)

        assert len(out.splitlines()) == 11
        assert out.splitlines()[-1].startswith("…")


class TestReadFile:
    def test_reads_with_line_numbers(self, repo: Path) -> None:
        out = read_file(repo, "src/app.py")

        assert out.splitlines()[0] == "src/app.py (lines 1-2 of 2)"
        assert "   1  def main():" in out

    def test_reads_a_line_range(self, repo: Path) -> None:
        (repo / "long.txt").write_text("".join(f"line {i}\n" for i in range(1, 1001)))

        out = read_file(repo, "long.txt", start_line=10, end_line=12)

        assert out.splitlines()[0] == "long.txt (lines 10-12 of 1000)"
        assert "line 11" in out and "line 13" not in out

    def test_starting_past_the_end_is_a_clear_error(self, repo: Path) -> None:
        with pytest.raises(FileAccessError, match="only 2 lines"):
            read_file(repo, "src/app.py", start_line=50)

    def test_long_files_are_capped(self, repo: Path) -> None:
        (repo / "long.txt").write_text("".join(f"line {i}\n" for i in range(1, 1001)))

        out = read_file(repo, "long.txt")

        assert f"(lines 1-{MAX_LINES} of 1000)" in out
        assert "more lines" in out

    def test_redacts_secrets_in_contents(self, repo: Path) -> None:
        out = read_file(repo, "config.py")

        assert "abcdefgh12345678" not in out

    def test_refuses_binary_files(self, repo: Path) -> None:
        with pytest.raises(FileAccessError, match="binary"):
            read_file(repo, "logo.png")

    def test_refuses_folders_and_missing_files(self, repo: Path) -> None:
        with pytest.raises(FileAccessError):
            read_file(repo, "src")
        with pytest.raises(FileAccessError, match="No such file"):
            read_file(repo, "nope.txt")


class TestSearch:
    def test_finds_matches_with_paths_and_line_numbers(self, repo: Path) -> None:
        out = search(repo, "deploy")

        assert "README.md:2: The deploy is blocked on the migration." in out
        assert "src/app.py:2:     return 'deploy'" in out

    def test_never_searches_denied_vendored_or_outside_files(self, repo: Path) -> None:
        out = search(repo, "x" * 10) + search(repo, "private stuff") + search(repo, "SECRET")

        assert ".env" not in out and "node_modules" not in out and "outside" not in out
        assert "No matches" in out

    def test_regex_mode(self, repo: Path) -> None:
        assert "src/app.py:1:" in search(repo, r"^def \w+", regex=True)

    def test_bad_regex_is_a_clear_error(self, repo: Path) -> None:
        with pytest.raises(FileAccessError, match="regular expression"):
            search(repo, "(", regex=True)

    def test_results_are_capped_and_redacted(self, repo: Path) -> None:
        (repo / "many.txt").write_text("".join("deploy\n" for _ in range(500)))

        out = search(repo, "deploy", limit=20)

        assert len([ln for ln in out.splitlines() if ":" in ln]) <= 20
        assert "more matches" in out
        assert "abcdefgh12345678" not in search(repo, "API_KEY")


def test_symlinked_directories_are_not_followed_out(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    secret_dir = tmp_path / "home-secrets"
    secret_dir.mkdir()
    (secret_dir / "diary.txt").write_text("deploy secrets\n")
    os.symlink(secret_dir, root / "linked")

    assert "No matches" in search(root, "deploy")
    with pytest.raises(FileAccessError):
        list_files(root, "linked")


def test_catastrophic_regexes_cannot_hang_the_agent(tmp_path: Path) -> None:
    import time as _time

    root = tmp_path / "root"
    root.mkdir()
    (root / "a.txt").write_text("a" * 60 + " b\n")  # not base64, so redaction leaves it

    start = _time.monotonic()
    with pytest.raises(FileAccessError, match="too slow"):
        search(root, "(a|aa)+$", regex=True)

    assert _time.monotonic() - start < 2


def test_file_names_with_secrets_are_redacted_in_listings(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    (root / "backup-AKIAIOSFODNN7EXAMPLE.txt").write_text("x")

    assert "AKIAIOSFODNN7EXAMPLE" not in list_files(root)
    assert "AKIAIOSFODNN7EXAMPLE" not in list_files(root, pattern="*.txt")


KEY = (
    "-----BEGIN PRIVATE KEY-----\n"
    + ("MIIEvQ" + "B" * 58 + "\n") * 4
    + "-----END PRIVATE KEY-----\n"
)


def test_keys_inside_ordinary_files_never_leak(repo: Path) -> None:
    (repo / "settings.py").write_text("DEBUG = True\nKEY = '''\n" + KEY + "'''\nNAME = 'demo'\n")
    ranged = read_file(repo, "settings.py", start_line=4)
    found = search(repo, "MIIEvQ")
    assert "MIIEvQ" not in ranged and "NAME = 'demo'" in ranged
    assert found == "No matches for 'MIIEvQ'"
    # Line numbers still match the file after redaction.
    assert "  10  NAME = 'demo'" in read_file(repo, "settings.py")


def test_search_cannot_probe_for_a_secret_value(repo: Path) -> None:
    (repo / "db.ini").write_text("password = hunter2pw\n")
    assert search(repo, "hunter2pw") == "No matches for 'hunter2pw'"


def test_reading_a_named_pipe_is_refused(repo: Path) -> None:
    os.mkfifo(repo / "pipe")
    with pytest.raises(FileAccessError, match="not a regular file"):
        read_file(repo, "pipe")


def test_mooz_home_is_never_visible(repo: Path) -> None:
    (repo / ".mooz" / "agents" / "atlas").mkdir(parents=True)
    (repo / ".mooz" / "agents" / "atlas" / "memory.jsonl").write_text('{"text": "private"}\n')
    assert ".mooz" not in list_files(repo)
    with pytest.raises(FileAccessError):
        read_file(repo, ".mooz/agents/atlas/memory.jsonl")
    assert search(repo, "private") == "No matches for 'private'"
