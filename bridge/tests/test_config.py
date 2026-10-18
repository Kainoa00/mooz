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
