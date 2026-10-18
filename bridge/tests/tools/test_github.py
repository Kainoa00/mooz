"""Read-only GitHub access, against a mocked GitHub API (never the real one in unit tests)."""

import httpx
import pytest
import respx

from mooz_agent.tools.github import API, GitHub, GitHubError

pytestmark = pytest.mark.unit

REPO = "kainoa00/mooz"
TOKEN = "ghp_" + "x" * 36


@pytest.fixture
def gh() -> GitHub:
    return GitHub(token=TOKEN)


def issue(number: int, title: str, **extra: object) -> dict[str, object]:
    return {
        "number": number,
        "title": title,
        "state": "open",
        "user": {"login": "zach"},
        "comments": 2,
        "updated_at": "2026-10-17T10:00:00Z",
        "labels": [{"name": "bug"}],
        "html_url": f"https://github.com/{REPO}/issues/{number}",
        "body": "Steps to reproduce…",
        **extra,
    }


@respx.mock
def test_lists_open_issues_without_pull_requests(gh: GitHub) -> None:
    route = respx.get(f"{API}/repos/{REPO}/issues").respond(
        json=[issue(12, "Chat scrolls back"), issue(13, "A PR", pull_request={})]
    )

    out = gh.issues(REPO)

    assert "#12 [open] Chat scrolls back (by zach, 2 comments, updated 2026-10-17) bug" in out
    assert "#13" not in out
    request = route.calls.last.request
    assert request.headers["authorization"] == f"Bearer {TOKEN}"
    assert request.url.params["state"] == "open"


@respx.mock
def test_searches_issues_by_text(gh: GitHub) -> None:
    route = respx.get(f"{API}/search/issues").respond(json={"items": [issue(7, "Login loop")]})

    out = gh.issues(REPO, state="closed", query="login")

    assert "#7" in out
    assert route.calls.last.request.url.params["q"] == f"repo:{REPO} is:issue state:closed login"


@respx.mock
def test_reads_an_issue_with_its_comments(gh: GitHub) -> None:
    respx.get(f"{API}/repos/{REPO}/issues/12").respond(json=issue(12, "Chat scrolls back"))
    respx.get(f"{API}/repos/{REPO}/issues/12/comments").respond(
        json=[
            {"user": {"login": "kai"}, "created_at": "2026-10-17T11:00:00Z", "body": "Seen it too"}
        ]
    )

    out = gh.issue(REPO, 12)

    assert out.startswith("#12 [open] Chat scrolls back")
    assert "Steps to reproduce" in out and "kai (2026-10-17): Seen it too" in out


@respx.mock
def test_pull_requests_with_reviews_files_and_checks(gh: GitHub) -> None:
    respx.get(f"{API}/repos/{REPO}/pulls").respond(
        json=[
            {
                "number": 5,
                "title": "Add tasks",
                "state": "open",
                "user": {"login": "kai"},
                "draft": False,
                "head": {"ref": "tasks"},
                "base": {"ref": "main"},
                "updated_at": "2026-10-18T09:00:00Z",
            }
        ]
    )
    respx.get(f"{API}/repos/{REPO}/pulls/5").respond(
        json={
            "number": 5,
            "title": "Add tasks",
            "state": "open",
            "user": {"login": "kai"},
            "draft": False,
            "merged": False,
            "head": {"ref": "tasks", "sha": "abc1234def"},
            "base": {"ref": "main"},
            "body": "Background research",
            "additions": 120,
            "deletions": 4,
            "changed_files": 2,
        }
    )
    respx.get(f"{API}/repos/{REPO}/pulls/5/reviews").respond(
        json=[{"user": {"login": "zach"}, "state": "APPROVED"}]
    )
    respx.get(f"{API}/repos/{REPO}/pulls/5/files").respond(
        json=[{"filename": "bridge/tasks.py", "status": "added", "additions": 100, "deletions": 0}]
    )
    respx.get(f"{API}/repos/{REPO}/commits/abc1234def/check-runs").respond(
        json={
            "check_runs": [
                {"name": "web", "status": "completed", "conclusion": "success"},
                {"name": "bridge", "status": "completed", "conclusion": "failure"},
            ]
        }
    )

    assert "#5 [open] Add tasks (by kai, tasks → main)" in gh.pulls(REPO)
    out = gh.pull(REPO, 5)
    assert "zach: approved" in out
    assert "bridge/tasks.py (added, +100 -0)" in out
    assert "1 passed, 1 failed" in out and "bridge: failure" in out


@respx.mock
def test_ci_on_the_default_branch(gh: GitHub) -> None:
    respx.get(f"{API}/repos/{REPO}").respond(json={"default_branch": "main"})
    respx.get(f"{API}/repos/{REPO}/commits/main/check-runs").respond(
        json={"check_runs": [{"name": "lint", "status": "in_progress", "conclusion": None}]}
    )

    out = gh.ci(REPO)

    assert out.startswith("CI on main: 1 running") and "lint: in progress" in out


@respx.mock
def test_errors_are_plain_and_never_show_the_token(gh: GitHub) -> None:
    respx.get(f"{API}/repos/{REPO}/issues").respond(
        401, json={"message": f"Bad credentials {TOKEN}"}
    )
    respx.get(f"{API}/repos/{REPO}/pulls").respond(
        403, headers={"x-ratelimit-remaining": "0"}, json={"message": "rate limit"}
    )
    respx.get(f"{API}/repos/{REPO}/issues/99").respond(404, json={"message": "Not Found"})
    respx.get(f"{API}/repos/{REPO}").mock(side_effect=httpx.ConnectError("boom"))

    for call, expected in [
        (lambda: gh.issues(REPO), "rejected the token"),
        (lambda: gh.pulls(REPO), "rate limit"),
        (lambda: gh.issue(REPO, 99), "No such"),
        (lambda: gh.ci(REPO), "Couldn't reach GitHub"),
    ]:
        with pytest.raises(GitHubError, match=expected) as err:
            call()
        assert TOKEN not in str(err.value)


@respx.mock
def test_output_is_redacted_and_capped(gh: GitHub) -> None:
    leak = "here is my key sk-ant-" + "y" * 40
    respx.get(f"{API}/repos/{REPO}/issues/1").respond(
        json=issue(1, "Leak", body=leak + "\n" + "z" * 50_000)
    )
    respx.get(f"{API}/repos/{REPO}/issues/1/comments").respond(json=[])

    out = gh.issue(REPO, 1)

    assert "sk-ant-" not in out and "[redacted]" in out
    assert len(out) < 25_000


def test_rejects_bad_arguments(gh: GitHub) -> None:
    for bad in ["../etc", "a/b/c", "owner/..", "-x/y", ""]:
        with pytest.raises(GitHubError, match="owner/name"):
            gh.issues(bad)
    with pytest.raises(GitHubError, match="number"):
        gh.issue(REPO, 0)
    with pytest.raises(GitHubError, match="branch"):
        gh.ci(REPO, "main;rm -rf")
    with pytest.raises(GitHubError, match="state"):
        gh.issues(REPO, state="everything")


@respx.mock
def test_works_without_a_token_for_public_repos() -> None:
    route = respx.get(f"{API}/repos/{REPO}/pulls").respond(json=[])
    assert GitHub(token=None).pulls(REPO) == "No open pull requests."
    assert "authorization" not in route.calls.last.request.headers
