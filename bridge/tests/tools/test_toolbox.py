import json
import subprocess
from pathlib import Path

import pytest

from mooz_agent.config import AgentConfig
from mooz_agent.memory import MemoryStore
from mooz_agent.tools.toolbox import Scope, ToolBox

pytestmark = pytest.mark.unit

OWNER = Scope(owner=True, asker_name="Zach")
GUEST = Scope(owner=False, asker_name="Kainoa")


@pytest.fixture
def box(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ToolBox:
    monkeypatch.setenv("MOOZ_HOME", str(tmp_path / "home"))
    private = tmp_path / "secret-project"
    public = tmp_path / "team-docs"
    private.mkdir()
    public.mkdir()
    (private / "plan.md").write_text("Acquisition target: Initech\n")
    (public / "notes.md").write_text("Standup is at 9am. Deploy on Thursdays.\n")
    for repo in (private, public):
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repo, check=True)
        subprocess.run(
            ["git", "-c", "user.name=Z", "-c", "user.email=z@x", "add", "-A"], cwd=repo, check=True
        )
        subprocess.run(
            [
                "git",
                "-c",
                "user.name=Z",
                "-c",
                "user.email=z@x",
                "commit",
                "-qm",
                f"init {repo.name}",
            ],
            cwd=repo,
            check=True,
        )
    cfg = AgentConfig(name="Atlas")
    cfg.add_source(private, label="secret-project")
    cfg.add_source(public, label="team-docs", public=True)
    memory = MemoryStore(tmp_path / "memory.jsonl")
    memory.remember("Zach is interviewing at Initech", public=False)
    memory.remember("The team offsite is in May", public=True)
    return ToolBox(cfg, memory, owner_name="Zach")


def names(box: ToolBox, scope: Scope) -> set[str]:
    return {spec.name for spec in box.specs(scope)}


def test_owner_gets_every_tool_guests_get_no_memory_writes(box: ToolBox) -> None:
    assert names(box, OWNER) == {
        "list_files", "read_file", "search", "git_status", "git_log", "git_show", "git_diff",
        "recall", "remember", "forget",
    }  # fmt: skip
    assert names(box, GUEST) == names(box, OWNER) - {"remember", "forget"}


def test_specs_are_strict_and_only_name_visible_sources(box: ToolBox) -> None:
    for scope, expected in ((OWNER, ["secret-project", "team-docs"]), (GUEST, ["team-docs"])):
        for spec in box.specs(scope):
            assert spec.parameters["additionalProperties"] is False
            source = spec.parameters["properties"].get("source")
            if source:
                assert source["enum"] == expected
        assert "secret-project" in json.dumps([s.parameters for s in box.specs(OWNER)])
    assert "secret-project" not in json.dumps([s.parameters for s in box.specs(GUEST)])
    assert "secret-project" not in json.dumps([s.description for s in box.specs(GUEST)])


def test_sources_summary_lists_only_what_the_asker_may_see(box: ToolBox) -> None:
    assert "secret-project" in box.sources_summary(OWNER)
    assert "secret-project" not in box.sources_summary(GUEST)
    assert "team-docs" in box.sources_summary(GUEST)


PRIVATE_CALLS = [
    ("list_files", {"source": "secret-project"}),
    ("read_file", {"source": "secret-project", "path": "plan.md"}),
    ("search", {"query": "Initech", "source": "secret-project"}),
    ("git_status", {"source": "secret-project"}),
    ("git_log", {"source": "secret-project"}),
    ("git_show", {"source": "secret-project", "ref": "HEAD"}),
    ("git_diff", {"source": "secret-project"}),
]


@pytest.mark.parametrize(("tool", "args"), PRIVATE_CALLS)
def test_guests_cannot_reach_private_sources_by_any_tool(
    box: ToolBox, tool: str, args: dict[str, str]
) -> None:
    result = box.dispatch(tool, args, GUEST)

    assert result.is_error
    assert result.content == "No source called 'secret-project'"


@pytest.mark.parametrize(("tool", "args"), PRIVATE_CALLS)
def test_owner_can_use_every_tool_on_private_sources(
    box: ToolBox, tool: str, args: dict[str, str]
) -> None:
    result = box.dispatch(tool, args, OWNER)

    assert not result.is_error, result.content


def test_unknown_and_private_sources_look_the_same_to_guests(box: ToolBox) -> None:
    unknown = box.dispatch("read_file", {"source": "nope", "path": "x"}, GUEST)
    private = box.dispatch("read_file", {"source": "secret-project", "path": "plan.md"}, GUEST)

    assert unknown.content.replace("nope", "X") == private.content.replace("secret-project", "X")


def test_search_without_a_source_covers_only_visible_sources(box: ToolBox) -> None:
    guest = box.dispatch("search", {"query": "Initech"}, GUEST)
    owner = box.dispatch("search", {"query": "Initech"}, OWNER)

    assert "Acquisition" not in guest.content and "secret-project" not in guest.content
    assert "[secret-project] plan.md:1: Acquisition target: Initech" in owner.content


def test_guest_reads_public_sources(box: ToolBox) -> None:
    result = box.dispatch("read_file", {"source": "team-docs", "path": "notes.md"}, GUEST)

    assert not result.is_error
    assert "Standup is at 9am" in result.content


def test_recall_is_scoped(box: ToolBox) -> None:
    assert (
        "Initech"
        not in box.dispatch("recall", {"query": "Initech interview offsite"}, GUEST).content
    )
    assert "offsite" in box.dispatch("recall", {"query": "offsite"}, GUEST).content
    assert "Initech" in box.dispatch("recall", {"query": "Initech"}, OWNER).content


def test_memory_writes_are_owner_only_even_if_called_directly(box: ToolBox) -> None:
    denied = box.dispatch("remember", {"note": "Kainoa says hi"}, GUEST)
    forget = box.dispatch("forget", {"id": "m_anything"}, GUEST)

    assert denied.is_error and denied.content == "Only Zach can change my memory"
    assert forget.is_error and forget.content == "Only Zach can change my memory"


def test_owner_remembers_privately_by_default_and_publicly_on_request(box: ToolBox) -> None:
    box.dispatch("remember", {"note": "Ship M2 by Friday"}, OWNER)
    box.dispatch("remember", {"note": "Demo day is Monday", "public": True}, OWNER)

    assert (
        "Ship M2" not in box.dispatch("recall", {"query": "ship friday demo monday"}, GUEST).content
    )
    assert "Demo day" in box.dispatch("recall", {"query": "demo monday"}, GUEST).content


def test_owner_forgets_by_id(box: ToolBox) -> None:
    created = box.dispatch("remember", {"note": "temporary note"}, OWNER)
    note_id = created.content.split()[-1]

    assert not box.dispatch("forget", {"id": note_id}, OWNER).is_error
    assert box.dispatch("forget", {"id": note_id}, OWNER).is_error


@pytest.mark.parametrize(
    ("tool", "args"),
    [
        ("read_file", {"source": "team-docs"}),
        ("read_file", {"source": "team-docs", "path": 7}),
        ("search", {"query": ""}),
        ("git_log", {"source": "team-docs", "n": "lots"}),
        ("nonexistent_tool", {}),
    ],
)
def test_bad_arguments_and_unknown_tools_are_errors_not_exceptions(
    box: ToolBox, tool: str, args: dict[str, object]
) -> None:
    result = box.dispatch(tool, args, OWNER)

    assert result.is_error


def test_file_errors_become_tool_errors(box: ToolBox) -> None:
    result = box.dispatch(
        "read_file", {"source": "team-docs", "path": "../secret-project/plan.md"}, GUEST
    )

    assert result.is_error
    assert "Initech" not in result.content


def test_agent_without_sources_or_memory_offers_no_file_tools(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MOOZ_HOME", str(tmp_path))
    bare = ToolBox(AgentConfig(name="Atlas"), None, owner_name="Zach")

    assert bare.specs(OWNER) == []
    assert "no folders" in bare.sources_summary(OWNER)


# -- GitHub -----------------------------------------------------------------------------


class FakeGitHub:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    def __getattr__(self, name: str):  # type: ignore[no-untyped-def]
        def call(*args: object) -> str:
            self.calls.append((name, args))
            return f"{name} {args}"

        return call


@pytest.fixture
def gh_box(box: ToolBox) -> tuple[ToolBox, FakeGitHub]:
    box.config.add_github("acme/secret-app", label="secret-app")
    box.config.add_github("acme/website", public=True)
    fake = FakeGitHub()
    box.github = fake  # type: ignore[assignment]
    return box, fake


def test_github_tools_follow_the_same_scope_rules(gh_box: tuple[ToolBox, FakeGitHub]) -> None:
    box, fake = gh_box
    github_tools = {"github_issues", "github_issue", "github_pulls", "github_pull", "github_ci"}
    assert github_tools <= names(box, OWNER) and github_tools <= names(box, GUEST)
    spec = next(s for s in box.specs(GUEST) if s.name == "github_issues")
    assert spec.parameters["properties"]["source"]["enum"] == ["website"]

    denied = box.dispatch("github_issues", {"source": "secret-app"}, GUEST)
    assert denied.is_error and "No source called 'secret-app'" in denied.content
    assert fake.calls == []

    assert not box.dispatch("github_pull", {"source": "secret-app", "number": 5}, OWNER).is_error
    assert not box.dispatch("github_ci", {"source": "website", "ref": None}, GUEST).is_error
    assert fake.calls == [("pull", ("acme/secret-app", 5)), ("ci", ("acme/website", None))]


def test_github_tools_need_github_sources(box: ToolBox) -> None:
    assert not any(n.startswith("github_") for n in names(box, OWNER))


def test_folder_tools_never_take_a_github_source(gh_box: tuple[ToolBox, FakeGitHub]) -> None:
    box, _ = gh_box
    result = box.dispatch("read_file", {"source": "website", "path": "x"}, OWNER)
    assert result.is_error and "No source called 'website'" in result.content


def test_progress_descriptions_are_built_from_arguments(gh_box: tuple[ToolBox, FakeGitHub]) -> None:
    box, _ = gh_box
    assert (
        box.describe("read_file", {"source": "team-docs", "path": "notes.md"})
        == "Reading notes.md in team-docs"
    )
    assert (
        box.describe("github_issue", {"source": "website", "number": 12})
        == "Reading issue #12 in website"
    )
    assert (
        box.describe("github_ci", {"source": "website", "ref": None})
        == "Checking CI on the default branch in website"
    )
    assert (
        box.describe("search", {"query": "sk-ant-" + "q" * 40})
        == "Searching your sources for '[redacted]'"
    )
    assert box.describe("mystery", {}) == "Working"


def test_progress_everyone_sees_never_names_private_sources(
    gh_box: tuple[ToolBox, FakeGitHub],
) -> None:
    box, _ = gh_box
    shown = {
        box.describe("read_file", {"source": "secret-project", "path": "cuts.csv"}, public=True),
        box.describe("search", {"source": "secret-project", "query": "layoffs"}, public=True),
        box.describe("search", {"query": "layoffs"}, public=True),  # every source
        box.describe("github_issue", {"source": "secret-app", "number": 3}, public=True),
        box.describe("git_log", {"source": "secret-project"}, public=True),
        box.describe("recall", {"query": "layoffs"}, public=True),
    }
    assert not any("secret" in line or "cuts" in line or "layoffs" in line for line in shown)
    assert "Reading a private file" in shown
    # Public sources are named as before.
    assert (
        box.describe("read_file", {"source": "team-docs", "path": "notes.md"}, public=True)
        == "Reading notes.md in team-docs"
    )
    assert (
        box.describe("github_issue", {"source": "website", "number": 12}, public=True)
        == "Reading issue #12 in website"
    )
