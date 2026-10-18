"""Trade a one-time meeting code for a LiveKit token, waiting for the host's approval."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx


class ClaimError(Exception):
    """The server refused the claim, or the host never approved it."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ClaimTicket:
    request_id: str
    claim_secret: str


@dataclass(frozen=True)
class AgentGrant:
    token: str
    url: str
    room: str
    identity: str
    name: str


def _base(server: str) -> str:
    return server.rstrip("/")


def _raise_for_error(res: httpx.Response) -> dict[str, Any]:
    try:
        body: dict[str, Any] = res.json()
    except ValueError:
        body = {}
    if res.is_success:
        return body
    error = body.get("error") or {}
    raise ClaimError(
        str(error.get("code", "http_error")),
        str(error.get("message", f"Server responded {res.status_code}")),
    )


async def claim_code(http: httpx.AsyncClient, server: str, *, code: str, name: str) -> ClaimTicket:
    res = await http.post(f"{_base(server)}/api/agent/claim", json={"code": code, "name": name})
    body = _raise_for_error(res)
    return ClaimTicket(request_id=body["requestId"], claim_secret=body["claimSecret"])


async def wait_for_approval(
    http: httpx.AsyncClient,
    server: str,
    *,
    request_id: str,
    claim_secret: str,
    poll_interval: float = 2.0,
    max_wait: float = 600.0,
    on_pending: Callable[[], None] | None = None,
) -> AgentGrant:
    """Poll until the host approves (returns the grant) or denies (raises)."""
    url = f"{_base(server)}/api/agent/claim/{request_id}"
    headers = {"authorization": f"Bearer {claim_secret}"}
    deadline = time.monotonic() + max_wait
    announced = False
    while True:
        body = _raise_for_error(await http.get(url, headers=headers))
        status = body.get("status")
        if status == "approved":
            return AgentGrant(
                token=body["token"],
                url=body["url"],
                room=body["room"],
                identity=body["identity"],
                name=body["name"],
            )
        if status == "denied":
            raise ClaimError("denied", "The host declined your agent.")
        if status == "revoked":
            raise ClaimError("revoked", "The host removed your agent from this meeting.")
        if status == "expired":
            raise ClaimError(
                "expired", "This approval has expired. Get a new code from the meeting."
            )
        if time.monotonic() >= deadline:
            raise ClaimError("timeout", "The host did not approve your agent in time.")
        if not announced and on_pending:
            on_pending()
        announced = True
        await asyncio.sleep(poll_interval)
