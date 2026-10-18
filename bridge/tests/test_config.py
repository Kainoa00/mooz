import stat
from pathlib import Path

import pytest

from mooz_agent.config import AgentConfig, ConfigError, Source, agent_dir, agents_root

pytestmark = pytest.mark.unit


@pytest.fixture(autouse=True)
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("MOOZ_HOME", str(tmp_path / "mooz"))
    return tmp_path


def test_agents_live_under_mooz_home(home: Path) -> None:
    assert agents_root() == home / "mooz" / "agents"
    assert agent_dir("Zach's Grok") == home / "mooz" / "agents" / "zachs-grok"


def test_round_trips_through_toml(home: Path) -> None:
    repo = home / "repo"
    repo.mkdir()
    cfg = AgentConfig(
        name="Atlas",
        brain="grok",
        model="grok-4.7",
        voice_id="v1",
        sources=[Source(label="repo", path=repo, public=True)],
    )
    cfg.save()

    loaded = AgentConfig.load("Atlas")

    assert loaded == cfg
    assert (agent_dir("Atlas") / "agent.toml").exists()


def test_agent_folder_is_private(home: Path) -> None:
    AgentConfig(name="Atlas").save()

    mode = stat.S_IMODE(agent_dir("Atlas").stat().st_mode)
    assert mode == 0o700


def test_missing_agent_has_a_helpful_error() -> None:
    with pytest.raises(ConfigError, match="mooz-agent init Atlas"):
        AgentConfig.load("Atlas")


@pytest.mark.parametrize("name", ["", "A", "2pac", "x" * 25])
def test_rejects_invalid_names(name: str) -> None:
    with pytest.raises(ConfigError):
        AgentConfig(name=name).validate()


def test_rejects_unknown_brain() -> None:
    with pytest.raises(ConfigError, match="claude or grok"):
        AgentConfig(name="Atlas", brain="gpt").validate()  # type: ignore[arg-type]


def test_add_source_derives_a_unique_label_and_absolute_path(home: Path) -> None:
    a = home / "code" / "mooz"
    b = home / "other" / "mooz"
    a.mkdir(parents=True)
    b.mkdir(parents=True)
    cfg = AgentConfig(name="Atlas")

    cfg.add_source(a)
    cfg.add_source(b, public=True)

    assert [(s.label, s.public) for s in cfg.sources] == [("mooz", False), ("mooz-2", True)]
    assert all(s.path.is_absolute() for s in cfg.sources)


def test_add_source_rejects_missing_folders_and_duplicate_labels(home: Path) -> None:
    folder = home / "notes"
    folder.mkdir()
    cfg = AgentConfig(name="Atlas")
    cfg.add_source(folder, label="notes")

    with pytest.raises(ConfigError, match="does not exist"):
        cfg.add_source(home / "nope")
    with pytest.raises(ConfigError, match="already"):
        cfg.add_source(folder, label="notes")


def test_remove_source(home: Path) -> None:
    folder = home / "notes"
    folder.mkdir()
    cfg = AgentConfig(name="Atlas")
    cfg.add_source(folder)

    cfg.remove_source("notes")

    assert cfg.sources == []
    with pytest.raises(ConfigError, match="No source"):
        cfg.remove_source("notes")


def test_public_and_private_views(home: Path) -> None:
    pub, priv = home / "pub", home / "priv"
    pub.mkdir()
    priv.mkdir()
    cfg = AgentConfig(name="Atlas")
    cfg.add_source(pub, public=True)
    cfg.add_source(priv)

    assert [s.label for s in cfg.visible_sources(owner=True)] == ["pub", "priv"]
    assert [s.label for s in cfg.visible_sources(owner=False)] == ["pub"]


def test_a_source_inside_the_agents_home_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MOOZ_HOME", str(tmp_path / "home"))
    inside = tmp_path / "home" / "agents" / "atlas"
    inside.mkdir(parents=True)
    with pytest.raises(ConfigError, match="private"):
        AgentConfig(name="Atlas").add_source(inside)


def test_github_repos_are_sources_with_the_same_rules(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MOOZ_HOME", str(tmp_path / "home"))
    (tmp_path / "web").mkdir()
    cfg = AgentConfig(name="Atlas")
    cfg.add_source(tmp_path / "web", label="web")
    repo = cfg.add_github("kainoa00/mooz")
    public = cfg.add_github("kainoa00/web", public=True)  # "web" is taken by the folder
    with pytest.raises(ConfigError, match="already exists"):
        cfg.add_github("kainoa00/other", label="mooz")

    assert (repo.label, repo.repo, repo.public) == ("mooz", "kainoa00/mooz", False)
    assert public.label == "web-2" and public.public
    assert cfg.visible_github(owner=False) == [public]
    for bad in ["kainoa00", "a/b/c", "../x", "x/.."]:
        with pytest.raises(ConfigError, match="owner/name"):
            cfg.add_github(bad)

    cfg.web_search = False
    cfg.save()
    loaded = AgentConfig.load("Atlas")
    assert loaded.github == cfg.github and loaded.web_search is False
    loaded.remove_source("mooz")
    assert [g.label for g in loaded.github] == ["web-2"]


def test_web_search_is_on_for_claude_and_off_for_grok_unless_set(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MOOZ_HOME", str(tmp_path / "home"))
    AgentConfig(name="Atlas").save()
    AgentConfig(name="Nova", brain="grok").save()
    AgentConfig(name="Echo", brain="grok", web_search=True).save()
    assert AgentConfig.load("Atlas").searches_web is True
    assert AgentConfig.load("Nova").searches_web is False  # its search also opens pages
    assert AgentConfig.load("Echo").searches_web is True
    assert "web_search" not in (AgentConfig.load("Atlas").home / "agent.toml").read_text()
