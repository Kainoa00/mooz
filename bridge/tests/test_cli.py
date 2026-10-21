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

    assert cli.main(["connect", "X", "--server", "https://s", "--name", "Atlas"]) == 2
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

    args = cli.parse_args(["connect", "X", "--server", "https://s"])

    assert args.name == "Nova"


def test_connect_requires_a_name(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("MOOZ_AGENT_NAME", raising=False)

    code = cli.main(["connect", "X", "--server", "https://s"])

    assert code == 2
    assert "--agent" in capsys.readouterr().err


def test_claim_errors_exit_cleanly(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def refuse(**_: object) -> AgentGrant:
        raise ClaimError("denied", "The host declined your agent.")

    monkeypatch.setattr(cli, "obtain_grant", refuse)

    code = cli.main(["connect", "X", "--server", "https://s", "--name", "Atlas"])

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

    assert cli.main(["connect", "X", "--server", "https://s", "--name", "Atlas"]) == 0
    assert ran == [grant]


def test_network_errors_become_a_clear_message(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import httpx

    async def unreachable(*_: object, **__: object) -> object:
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(cli, "claim_code", unreachable)

    assert cli.main(["connect", "X", "--server", "https://nowhere", "--name", "Atlas"]) == 1
    assert "Could not reach https://nowhere" in capsys.readouterr().err


@pytest.mark.parametrize(
    ("server", "allow_http", "ok"),
    [
        ("https://meet.example.com", False, True),
        ("http://localhost:3000", False, True),
        ("http://127.0.0.1:3000", False, True),
        ("http://[::1]:3000", False, True),
        ("http://meet.example.com", False, False),
        ("http://192.168.1.5:3000", False, False),
        ("http://192.168.1.5:3000", True, True),
        ("meet.example.com", True, False),
        ("ftp://meet.example.com", True, False),
    ],
)
def test_the_server_must_be_https_off_this_machine(server: str, allow_http: bool, ok: bool) -> None:
    assert (cli.server_problem(server, allow_http=allow_http) is None) is ok


def test_connect_refuses_plain_http_to_another_machine(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def never(**_: object) -> AgentGrant:
        raise AssertionError("the secret must not be sent")

    monkeypatch.setattr(cli, "obtain_grant", never)
    assert cli.main(["connect", "X", "--server", "http://meet.example.com", "--name", "Atlas"]) == 2
    assert "--allow-http" in capsys.readouterr().err


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
    assert cli.main(["connect", "X", "--server", "https://s", "--agent", "Nova"]) == 2
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

    assert cli.main(["connect", "X", "--server", "https://s", "--agent", "Atlas"]) == 0
    assert seen["name"] == "Atlas"
    assert seen["brain"] == "grok"


def test_local_voice_is_checked_before_joining(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from mooz_agent.providers.local import SpeechServerError

    cli.main(["init", "Atlas", "--voice-provider", "local"])
    assert AgentConfig.load("Atlas").voice_provider == "local"
    monkeypatch.delenv("MOOZ_PROVIDERS")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    monkeypatch.delenv("ELEVEN_API_KEY", raising=False)
    monkeypatch.setenv("MOOZ_SPEECH_URL", "http://10.0.0.9:3900/v1")
    joined: list[bool] = []

    async def down(_http: object, _settings: object) -> None:
        raise SpeechServerError(
            "Can't reach your speech server at http://10.0.0.9:3900/v1. Is it running?"
        )

    async def approve(**_: object) -> AgentGrant:
        joined.append(True)
        return AgentGrant(token="t", url="ws://lk", room="r", identity="a_1", name="Atlas")

    monkeypatch.setattr("mooz_agent.providers.local.check_speech_server", down)
    monkeypatch.setattr(cli, "obtain_grant", approve)
    assert cli.main(["connect", "X", "--server", "https://s", "--agent", "Atlas"]) == 2
    err = capsys.readouterr().err
    assert "unencrypted" in err and "Is it running?" in err and joined == []


def test_grok_needs_an_xai_key(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    cli.main(["init", "Atlas", "--brain", "grok"])
    monkeypatch.delenv("MOOZ_PROVIDERS")
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.setenv("ELEVEN_API_KEY", "x")

    assert cli.main(["connect", "X", "--server", "https://s", "--agent", "Atlas"]) == 2
    assert "XAI_API_KEY" in capsys.readouterr().err


def test_memory_add_list_forget(capsys: pytest.CaptureFixture[str]) -> None:
    cli.main(["init", "Atlas"])

    assert cli.main(["memory", "add", "Standup is at 9", "--public", "--agent", "Atlas"]) == 0
    note_id = capsys.readouterr().out.split()[-1]
    assert cli.main(["memory", "list", "--agent", "Atlas"]) == 0
    assert "public   Standup is at 9" in capsys.readouterr().out
    assert cli.main(["memory", "forget", note_id, "--agent", "Atlas"]) == 0
    assert cli.main(["memory", "forget", note_id, "--agent", "Atlas"]) == 2


def test_github_sources_and_web_search_from_the_cli(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["init", "Atlas", "--source", "github:kainoa00/mooz", "--no-web-search"]) == 0
    assert cli.main(["sources", "add", "github:kainoa00/site", "--public", "--agent", "Atlas"]) == 0

    cfg = AgentConfig.load("Atlas")
    assert [(g.repo, g.public) for g in cfg.github] == [
        ("kainoa00/mooz", False),
        ("kainoa00/site", True),
    ]
    assert cfg.web_search is False
    assert cli.main(["init", "Nova", "--brain", "grok", "--web-search"]) == 0
    assert AgentConfig.load("Nova").searches_web is True
    assert cli.main(["sources", "list", "--agent", "Atlas"]) == 0
    assert "github:kainoa00/mooz" in capsys.readouterr().out
    assert cli.main(["sources", "add", "github:not a repo", "--agent", "Atlas"]) == 2
