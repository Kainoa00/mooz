import httpx
import pytest
import respx

from mooz_agent.claim import AgentGrant, ClaimError, claim_code, wait_for_approval

SERVER = "https://mooz.example"
pytestmark = pytest.mark.unit


@respx.mock
async def test_claim_code_posts_code_and_name() -> None:
    route = respx.post(f"{SERVER}/api/agent/claim").respond(
        201, json={"requestId": "r_1", "claimSecret": "s3cret", "slug": "abc", "status": "pending"}
    )
    async with httpx.AsyncClient() as http:
        ticket = await claim_code(http, SERVER, code="ABCD-EFGH-JKLM", name="Atlas")

    assert ticket.request_id == "r_1"
    assert ticket.claim_secret == "s3cret"
    assert route.calls.last.request.read() == b'{"code":"ABCD-EFGH-JKLM","name":"Atlas"}'


@respx.mock
async def test_claim_code_surfaces_the_server_message() -> None:
    respx.post(f"{SERVER}/api/agent/claim").respond(
        409, json={"error": {"code": "name_taken", "message": 'Someone is already called "Atlas"'}}
    )
    async with httpx.AsyncClient() as http:
        with pytest.raises(ClaimError, match="already called") as exc:
            await claim_code(http, SERVER, code="X", name="Atlas")

    assert exc.value.code == "name_taken"


@respx.mock
async def test_claim_code_handles_a_non_json_error() -> None:
    respx.post(f"{SERVER}/api/agent/claim").respond(502, text="Bad Gateway")
    async with httpx.AsyncClient() as http:
        with pytest.raises(ClaimError, match="502"):
            await claim_code(http, SERVER, code="X", name="Atlas")


@respx.mock
async def test_wait_for_approval_polls_until_approved() -> None:
    route = respx.get(f"{SERVER}/api/agent/claim/r_1").mock(
        side_effect=[
            httpx.Response(200, json={"status": "pending"}),
            httpx.Response(200, json={"status": "pending"}),
            httpx.Response(
                200,
                json={
                    "status": "approved",
                    "token": "jwt",
                    "url": "ws://lk:7880",
                    "room": "abc",
                    "identity": "a_1",
                    "name": "Atlas",
                },
            ),
        ]
    )
    waits: list[str] = []
    async with httpx.AsyncClient() as http:
        grant = await wait_for_approval(
            http,
            SERVER,
            request_id="r_1",
            claim_secret="s3cret",
            poll_interval=0,
            on_pending=lambda: waits.append("pending"),
        )

    assert grant == AgentGrant(
        token="jwt", url="ws://lk:7880", room="abc", identity="a_1", name="Atlas"
    )
    assert route.call_count == 3
    assert waits == ["pending"]  # announced once, not on every poll
    assert route.calls.last.request.headers["authorization"] == "Bearer s3cret"


@respx.mock
async def test_wait_for_approval_raises_when_denied() -> None:
    respx.get(f"{SERVER}/api/agent/claim/r_1").respond(200, json={"status": "denied"})
    async with httpx.AsyncClient() as http:
        with pytest.raises(ClaimError, match="declined") as exc:
            await wait_for_approval(
                http, SERVER, request_id="r_1", claim_secret="s", poll_interval=0
            )

    assert exc.value.code == "denied"


@respx.mock
async def test_wait_for_approval_gives_up_after_the_timeout() -> None:
    respx.get(f"{SERVER}/api/agent/claim/r_1").respond(200, json={"status": "pending"})
    async with httpx.AsyncClient() as http:
        with pytest.raises(ClaimError, match="approve") as exc:
            await wait_for_approval(
                http, SERVER, request_id="r_1", claim_secret="s", poll_interval=0, max_wait=0
            )

    assert exc.value.code == "timeout"


@respx.mock
async def test_server_url_trailing_slash_is_ignored() -> None:
    respx.post(f"{SERVER}/api/agent/claim").respond(
        201, json={"requestId": "r_1", "claimSecret": "s", "slug": "abc", "status": "pending"}
    )
    async with httpx.AsyncClient() as http:
        ticket = await claim_code(http, SERVER + "/", code="X", name="Atlas")

    assert ticket.request_id == "r_1"


@pytest.mark.parametrize(
    ("status", "message"), [("revoked", "removed your agent"), ("expired", "new code")]
)
@respx.mock
async def test_wait_for_approval_explains_revoked_and_expired(status: str, message: str) -> None:
    respx.get(f"{SERVER}/api/agent/claim/r_1").respond(200, json={"status": status})
    async with httpx.AsyncClient() as http:
        with pytest.raises(ClaimError, match=message) as exc:
            await wait_for_approval(
                http, SERVER, request_id="r_1", claim_secret="s", poll_interval=0
            )

    assert exc.value.code == status
