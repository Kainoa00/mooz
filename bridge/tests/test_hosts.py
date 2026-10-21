import httpx
import pytest

from mooz_agent.hosts import direct_client, is_this_machine

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    ("host", "here"),
    [
        ("localhost", True),
        ("LOCALHOST.", True),
        ("127.0.0.1", True),
        ("127.5.6.7", True),
        ("::1", True),
        ("[::1]", True),
        ("127.gpu.example.com", False),
        ("127.0.0.1.nip.io", False),
        ("localhost.example", False),
        ("10.0.0.5", False),
        ("", False),
    ],
)
def test_knows_which_hosts_are_this_machine(host: str, here: bool) -> None:
    assert is_this_machine(host) is here


async def test_never_sends_requests_for_this_machine_through_a_proxy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HTTP_PROXY", "http://proxy.example:3128")
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example:3128")
    monkeypatch.delenv("NO_PROXY", raising=False)
    monkeypatch.delenv("no_proxy", raising=False)
    async with direct_client(["http://127.0.0.2:3900/v1"]) as client:
        direct = client._transport
        for url in [
            "http://127.0.0.1:3900/v1/models",
            "http://localhost:3000/api/agent/claim",
            "http://[::1]:3900/v1",
            "http://127.0.0.2:3900/v1",
        ]:
            assert client._transport_for_url(httpx.URL(url)) is direct, url
        # Everything else still uses the proxy the owner set.
        assert client._transport_for_url(httpx.URL("http://10.0.0.5/v1")) is not direct
