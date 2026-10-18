from pathlib import Path

import pytest

from mooz_agent import cli
from mooz_agent.claim import AgentGrant, ClaimError
from mooz_agent.config import AgentConfig

pytestmark = pytest.mark.unit


@pytest.fixture(autouse=True)
def offline(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MOOZ_PROVIDERS", "fake")
    monkeypatch.setenv("MOOZ_HOME", str(tmp_path / "mooz"))
    monkeypatch.delenv("MOOZ_AGENT", raising=False)


def test_missing_keys_fail_before_joining(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("MOOZ_PROVIDERS")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ELEVEN_API_KEY", raising=False)

    assert cli.main(["connect", "X", "--server", "http://s", "--name", "Atlas"]) == 2
    assert "ANTHROPIC_API_KEY and ELEVEN_API_KEY" in capsys.readouterr().err


def test_parse_connect_arguments() -> None:
    args = cli.parse_args(
        ["connect", "ABCD-EFGH-JKLM", "--server", "https://m.example", "--name", "Atlas"]
    )

    assert args.command == "connect"
    assert args.code == "ABCD-EFGH-JKLM"
    assert args.server == "https://m.example"
    assert args.name == "Atlas"


def test_name_defaults_to_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MOOZ_AGENT_NAME", "Nova")

    args = cli.parse_args(["connect", "X", "--server", "http://s"])

    assert args.name == "Nova"


def test_connect_requires_a_name(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("MOOZ_AGENT_NAME", raising=False)

    code = cli.main(["connect", "X", "--server", "http://s"])

    assert code == 2
    assert "--agent" in capsys.readouterr().err


def test_claim_errors_exit_cleanly(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def refuse(**_: object) -> AgentGrant:
        raise ClaimError("denied", "The host declined your agent.")

    monkeypatch.setattr(cli, "obtain_grant", refuse)

    code = cli.main(["connect", "X", "--server", "http://s", "--name", "Atlas"])

    assert code == 1
    assert "The host declined your agent." in capsys.readouterr().err


def test_connect_runs_the_agent_with_the_grant(monkeypatch: pytest.MonkeyPatch) -> None:
    grant = AgentGrant(token="t", url="ws://lk", room="abc", identity="a_1", name="Atlas")
    ran: list[AgentGrant] = []

    async def approve(**_: object) -> AgentGrant:
        return grant

    async def run(g: AgentGrant, config: AgentConfig) -> None:
        assert config.name == "Atlas"
        ran.append(g)

    monkeypatch.setattr(cli, "obtain_grant", approve)
    monkeypatch.setattr(cli, "run_agent", run)

    assert cli.main(["connect", "X", "--server", "http://s", "--name", "Atlas"]) == 0
    assert ran == [grant]


def test_network_errors_become_a_clear_message(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import httpx

    async def unreachable(*_: object, **__: object) -> object:
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(cli, "claim_code", unreachable)

    assert cli.main(["connect", "X", "--server", "http://nowhere", "--name", "Atlas"]) == 1
    assert "Could not reach http://nowhere" in capsys.readouterr().err


def test_init_creates_an_agent_with_sources(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    (tmp_path / "repo").mkdir()
    (tmp_path / "docs").mkdir()

    code = cli.main(
        [
            "init",
            "Atlas",
            "--brain",
            "grok",
            "--source",
            str(tmp_path / "repo"),
            "--public-source",
            str(tmp_path / "docs"),
        ]
    )

    assert code == 0
    cfg = AgentConfig.load("Atlas")
    assert cfg.brain == "grok"
    assert [(s.label, s.public) for s in cfg.sources] == [("repo", False), ("docs", True)]
    assert "public" in capsys.readouterr().out


def test_init_refuses_to_overwrite_without_force(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["init", "Atlas"]) == 0
    assert cli.main(["init", "Atlas"]) == 2
    assert "--force" in capsys.readouterr().err
    assert cli.main(["init", "Atlas", "--force"]) == 0


def test_sources_add_list_remove(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    (tmp_path / "notes").mkdir()
    cli.main(["init", "Atlas"])

    assert (
        cli.main(["sources", "add", str(tmp_path / "notes"), "--public", "--agent", "Atlas"]) == 0
    )
    assert AgentConfig.load("Atlas").sources[0].public
    assert cli.main(["sources", "list", "--agent", "Atlas"]) == 0
    assert cli.main(["sources", "remove", "notes", "--agent", "Atlas"]) == 0
    assert AgentConfig.load("Atlas").sources == []
    assert cli.main(["sources", "remove", "notes", "--agent", "Atlas"]) == 2


def test_connect_with_an_unknown_agent_says_how_to_create_it(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert cli.main(["connect", "X", "--server", "http://s", "--agent", "Nova"]) == 2
    assert "mooz-agent init Nova" in capsys.readouterr().err


def test_connect_uses_the_saved_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    cli.main(["init", "Atlas", "--brain", "grok"])
    seen: dict[str, object] = {}

    async def approve(**kwargs: object) -> AgentGrant:
        seen.update(kwargs)
        return AgentGrant(token="t", url="ws://lk", room="r", identity="a_1", name="Atlas")

    async def run(_g: AgentGrant, config: AgentConfig) -> None:
        seen["brain"] = config.brain

    monkeypatch.setattr(cli, "obtain_grant", approve)
    monkeypatch.setattr(cli, "run_agent", run)

    assert cli.main(["connect", "X", "--server", "http://s", "--agent", "Atlas"]) == 0
    assert seen["name"] == "Atlas"
    assert seen["brain"] == "grok"


def test_grok_needs_an_xai_key(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    cli.main(["init", "Atlas", "--brain", "grok"])
    monkeypatch.delenv("MOOZ_PROVIDERS")
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.setenv("ELEVEN_API_KEY", "x")

    assert cli.main(["connect", "X", "--server", "http://s", "--agent", "Atlas"]) == 2
    assert "XAI_API_KEY" in capsys.readouterr().err
