import pytest

from mooz_agent import cli
from mooz_agent.claim import AgentGrant, ClaimError

pytestmark = pytest.mark.unit


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
    assert "--name" in capsys.readouterr().err


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

    async def run(g: AgentGrant) -> None:
        ran.append(g)

    monkeypatch.setattr(cli, "obtain_grant", approve)
    monkeypatch.setattr(cli, "run_agent", run)

    assert cli.main(["connect", "X", "--server", "http://s", "--name", "Atlas"]) == 0
    assert ran == [grant]
