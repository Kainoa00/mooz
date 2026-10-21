"""Taking turns on the meeting's floor (docs/protocol.md, "Taking turns").

Before the agent posts or speaks an answer it asks the mooz server for a turn, waits until
it's granted, and gives it back when done: one agent answers at a time, answers to people
first. A reply to another agent may be held until a person in the meeting lets the agents
continue. An older server without a floor has no turns; the agent then goes ahead (it keeps
its own limit on replies to agents either way).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, replace
from typing import Any, Literal, Protocol

import httpx

log = logging.getLogger(__name__)

Answering = Literal["person", "agent"]

# A held reply waits for a person to click Continue; past this it isn't worth saying.
MAX_WAIT_SECONDS = 300.0
# After a network hiccup while waiting, ask again this soon (a waiting turn lapses after 10 s).
RETRY_SECONDS = 1.0
# The server answers a check within 25 s; allow for the trip.
HTTP_TIMEOUT = httpx.Timeout(10.0, read=35.0)


@dataclass(frozen=True)
class Granted:
    """A turn to answer in. `deadline` (on the turn taker's clock) is when it's cut off."""

    deadline: float | None = None


# Go ahead without a turn: no floor to ask (an older server, or none at all).
LOCAL = Granted()


class TurnTaker(Protocol):
    def turn(
        self, *, answering: Answering, speak: bool, max_wait: float | None = None
    ) -> AbstractAsyncContextManager[Granted | None]:
        """Hold a turn for the body of the `async with`; None means don't answer."""
        ...


class NoFloor:
    """No meeting floor (tests, offline): always go ahead."""

    @asynccontextmanager
    async def turn(
        self, *, answering: Answering, speak: bool, max_wait: float | None = None
    ) -> AsyncIterator[Granted | None]:
        yield LOCAL


class _Unsupported(Exception):
    """This server has no turns."""


class _Garbled(Exception):
    """Not an answer from mooz (a proxy error page, say)."""


class _Refused(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class _Turn:
    id: str
    status: str
    ends_in: float | None = None


class Turns:
    """The bridge's side of the floor, with its claim secret."""

    def __init__(
        self,
        http: httpx.AsyncClient,
        server: str,
        *,
        request_id: str,
        claim_secret: str,
        clock: Callable[[], float] = time.monotonic,
        max_wait: float = MAX_WAIT_SECONDS,
        retry_seconds: float = RETRY_SECONDS,
    ) -> None:
        self._http = http
        self._base = f"{server.rstrip('/')}/api/agent/claim/{request_id}/turns"
        self._headers = {"authorization": f"Bearer {claim_secret}"}
        self._clock = clock
        self._max_wait = max_wait
        self._retry = retry_seconds
        # None until the server has answered a turn request one way or the other.
        self.supported: bool | None = None

    @asynccontextmanager
    async def turn(
        self, *, answering: Answering, speak: bool, max_wait: float | None = None
    ) -> AsyncIterator[Granted | None]:
        if self.supported is False:
            yield LOCAL
            return
        try:
            current = await self._call("POST", "", {"answering": answering, "speak": speak})
        except _Unsupported as err:
            if self.supported:
                # It answered turns before, so this is something in front of it (a tunnel or a
                # proxy between restarts): the floor is out of reach for now, not gone.
                yield self._unreachable(answering, err)
                return
            log.info("this mooz server doesn't keep turns: answering without them")
            self.supported = False
            yield LOCAL
            return
        except _Refused as err:
            log.warning("the server refused a turn (%s): not answering", err.code)
            yield None
            return
        except (httpx.HTTPError, _Garbled) as err:
            yield self._unreachable(answering, err)
            return
        self.supported = True
        try:
            current = await self._wait(current, self._max_wait if max_wait is None else max_wait)
            if current.status == "granted":
                ends = self._clock() + current.ends_in if current.ends_in is not None else None
                yield Granted(deadline=ends)
            else:
                yield None
        finally:
            if current.status != "ended":
                await self._release(current.id)

    @staticmethod
    def _unreachable(answering: Answering, err: Exception) -> Granted | None:
        """The floor is out of reach: answer a person anyway, but not another agent (with no
        floor to pause them, two agents could go back and forth on their owners' bills)."""
        go = answering == "person"
        log.warning(
            "could not ask for a turn (%s): %s",
            type(err).__name__,
            "answering anyway" if go else "not replying to another agent",
        )
        return LOCAL if go else None

    async def _wait(self, current: _Turn, max_wait: float) -> _Turn:
        give_up = self._clock() + max_wait
        announced = False
        while current.status in ("waiting", "held"):
            if current.status == "held" and not announced:
                log.info(
                    "an answer to another agent is waiting for a person to let the agents continue"
                )
                announced = True
            left = give_up - self._clock()
            if left <= 0:
                log.info("gave up waiting for a turn")
                return current
            try:
                # The server holds a check open for up to 25 s: never past the time left.
                current = await asyncio.wait_for(self._call("GET", f"/{current.id}"), left)
            except TimeoutError:
                log.info("gave up waiting for a turn")
                return current
            except _Refused as err:
                log.warning("lost a turn while waiting for it (%s)", err.code)
                return replace(current, status="ended")
            except (httpx.HTTPError, _Garbled, _Unsupported):
                await asyncio.sleep(min(self._retry, max(0.0, give_up - self._clock())))
        return current

    async def _release(self, turn_id: str) -> None:
        # Best effort: a turn the server doesn't hear back about runs out on its own.
        with contextlib.suppress(Exception):
            await self._call("POST", f"/{turn_id}/done")

    async def _call(self, method: str, path: str, body: dict[str, Any] | None = None) -> _Turn:
        res = await self._http.request(
            method, self._base + path, json=body, headers=self._headers, timeout=HTTP_TIMEOUT
        )
        try:
            data = res.json()
        except ValueError:
            data = None
        if not isinstance(data, dict):
            if res.status_code == 404:
                raise _Unsupported
            raise _Garbled(f"Server responded {res.status_code}")
        if not res.is_success:
            error = data.get("error") or {}
            raise _Refused(str(error.get("code", "http_error")), str(error.get("message", "")))
        turn = data.get("turn")
        if not isinstance(turn, dict) or not isinstance(turn.get("id"), str):
            raise _Garbled("no turn in the answer")
        ends = turn.get("endsInMs")
        return _Turn(
            id=turn["id"],
            status=str(turn.get("status")),
            ends_in=ends / 1000 if isinstance(ends, int | float) else None,
        )
