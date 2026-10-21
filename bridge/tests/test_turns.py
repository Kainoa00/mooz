import asyncio
import json
import logging

import httpx
import pytest
import respx

from mooz_agent.turns import LOCAL, NoFloor, Turns

SERVER = "https://mooz.example"
BASE = f"{SERVER}/api/agent/claim/r_1/turns"
pytestmark = pytest.mark.unit


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def turns(http: httpx.AsyncClient, clock: Clock | None = None, **kw: float) -> Turns:
    return Turns(
        http,
        SERVER,
        request_id="r_1",
        claim_secret="s3cret",
        clock=clock or Clock(),
        retry_seconds=0,
        **kw,
    )


def turn(status: str, **extra: object) -> httpx.Response:
    return httpx.Response(200, json={"turn": {"id": "t_1", "status": status, **extra}})


@respx.mock
async def test_takes_a_free_floor_at_once_and_gives_it_back() -> None:
    ask = respx.post(BASE).respond(
        201, json={"turn": {"id": "t_1", "status": "granted", "endsInMs": 45000}}
    )
    done = respx.post(f"{BASE}/t_1/done").mock(return_value=turn("ended", reason="done"))
    clock = Clock()
    async with httpx.AsyncClient() as http:
        floor = turns(http, clock)
        async with floor.turn(answering="person", speak=True) as granted:
            assert granted is not None and granted.deadline == 145.0
            assert not done.called
        assert floor.supported is True

    request = ask.calls.last.request
    assert request.headers["authorization"] == "Bearer s3cret"
    assert json.loads(request.read()) == {"answering": "person", "speak": True}
    assert done.called


@respx.mock
async def test_waits_its_turn_and_says_so_while_held(caplog: pytest.LogCaptureFixture) -> None:
    respx.post(BASE).respond(201, json={"turn": {"id": "t_1", "status": "held"}})
    check = respx.get(f"{BASE}/t_1").mock(
        side_effect=[turn("held"), turn("waiting"), turn("granted", endsInMs=10000)]
    )
    respx.post(f"{BASE}/t_1/done").mock(return_value=turn("ended"))
    caplog.set_level(logging.INFO, logger="mooz_agent.turns")
    async with (
        httpx.AsyncClient() as http,
        turns(http).turn(answering="agent", speak=False) as granted,
    ):
        assert granted is not None
    assert check.call_count == 3
    assert sum("let the agents continue" in r.message for r in caplog.records) == 1


@respx.mock
async def test_says_nothing_when_its_turn_ends_before_it_comes() -> None:
    respx.post(BASE).respond(201, json={"turn": {"id": "t_1", "status": "waiting"}})
    respx.get(f"{BASE}/t_1").mock(return_value=turn("ended", reason="replaced"))
    done = respx.post(f"{BASE}/t_1/done")
    async with (
        httpx.AsyncClient() as http,
        turns(http).turn(answering="person", speak=True) as granted,
    ):
        assert granted is None
    assert not done.called  # already over


@respx.mock
async def test_gives_up_after_waiting_too_long_and_withdraws() -> None:
    clock = Clock()
    respx.post(BASE).respond(201, json={"turn": {"id": "t_1", "status": "waiting"}})

    def later(_: httpx.Request) -> httpx.Response:
        clock.now += 200
        return turn("held")

    respx.get(f"{BASE}/t_1").mock(side_effect=later)
    done = respx.post(f"{BASE}/t_1/done").mock(return_value=turn("ended"))
    async with httpx.AsyncClient() as http:
        async with turns(http, clock, max_wait=300).turn(answering="agent", speak=True) as granted:
            assert granted is None
    assert done.called


@respx.mock
async def test_only_now_means_not_waiting_at_all() -> None:
    respx.post(BASE).respond(201, json={"turn": {"id": "t_1", "status": "waiting"}})
    check = respx.get(f"{BASE}/t_1")
    done = respx.post(f"{BASE}/t_1/done").mock(return_value=turn("ended"))
    async with httpx.AsyncClient() as http:
        async with turns(http).turn(answering="person", speak=True, max_wait=0) as granted:
            assert granted is None
    assert not check.called and done.called


@respx.mock
async def test_goes_ahead_on_a_server_without_turns_and_stops_asking() -> None:
    ask = respx.post(BASE).respond(404, text="<html>This page could not be found</html>")
    async with httpx.AsyncClient() as http:
        floor = turns(http)
        for _ in range(2):
            async with floor.turn(answering="agent", speak=True) as granted:
                assert granted is LOCAL
    assert ask.call_count == 1
    assert floor.supported is False


@respx.mock
async def test_says_nothing_when_the_server_refuses() -> None:
    respx.post(BASE).respond(
        409,
        json={"error": {"code": "not_in_meeting", "message": "This agent is not in the meeting"}},
    )
    async with (
        httpx.AsyncClient() as http,
        turns(http).turn(answering="person", speak=True) as granted,
    ):
        assert granted is None


@respx.mock
async def test_answers_a_person_but_not_an_agent_when_the_server_cannot_be_reached() -> None:
    respx.post(BASE).mock(side_effect=httpx.ConnectError("down"))
    async with httpx.AsyncClient() as http:
        floor = turns(http)
        async with floor.turn(answering="person", speak=True) as granted:
            assert granted is LOCAL
        # With no floor to pause them, two agents could go back and forth for ever.
        async with floor.turn(answering="agent", speak=True) as granted:
            assert granted is None
        assert floor.supported is None  # it may be back next time


@respx.mock
async def test_goes_ahead_on_a_garbled_answer_only_for_a_person() -> None:
    respx.post(BASE).respond(502, text="Bad Gateway")
    async with httpx.AsyncClient() as http:
        async with turns(http).turn(answering="person", speak=True) as granted:
            assert granted is LOCAL
        async with turns(http).turn(answering="agent", speak=True) as granted:
            assert granted is None


@respx.mock
async def test_keeps_asking_through_a_network_hiccup() -> None:
    respx.post(BASE).respond(201, json={"turn": {"id": "t_1", "status": "waiting"}})
    respx.get(f"{BASE}/t_1").mock(
        side_effect=[httpx.ReadTimeout("slow"), turn("granted", endsInMs=1000)]
    )
    respx.post(f"{BASE}/t_1/done").mock(side_effect=httpx.ConnectError("down"))  # swallowed
    async with (
        httpx.AsyncClient() as http,
        turns(http).turn(answering="person", speak=True) as granted,
    ):
        assert granted is not None


@respx.mock
async def test_stops_waiting_when_the_server_forgets_the_turn() -> None:
    respx.post(BASE).respond(201, json={"turn": {"id": "t_1", "status": "waiting"}})
    respx.get(f"{BASE}/t_1").respond(
        404, json={"error": {"code": "turn_not_found", "message": "No such turn"}}
    )
    done = respx.post(f"{BASE}/t_1/done")
    async with (
        httpx.AsyncClient() as http,
        turns(http).turn(answering="person", speak=True) as granted,
    ):
        assert granted is None
    assert not done.called


@respx.mock
async def test_gives_the_turn_back_when_the_answer_is_cancelled() -> None:
    respx.post(BASE).respond(
        201, json={"turn": {"id": "t_1", "status": "granted", "endsInMs": 45000}}
    )
    done = respx.post(f"{BASE}/t_1/done").mock(return_value=turn("ended"))

    async def answer(floor: Turns) -> None:
        async with floor.turn(answering="person", speak=True):
            await asyncio.sleep(10)

    async with httpx.AsyncClient() as http:
        task = asyncio.ensure_future(answer(turns(http)))
        await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert done.called


async def test_no_floor_always_goes_ahead() -> None:
    floor = NoFloor()
    async with floor.turn(answering="agent", speak=True) as granted:
        assert granted is LOCAL and granted.deadline is None


@respx.mock
async def test_a_check_left_open_past_max_wait_gives_up_and_withdraws() -> None:
    respx.post(BASE).respond(201, json={"turn": {"id": "t_1", "status": "waiting"}})

    async def slow(_request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(2)  # the server holds the check open; the floor frees up late
        return turn("granted", endsInMs=45000)

    respx.get(f"{BASE}/t_1").mock(side_effect=slow)
    done = respx.post(f"{BASE}/t_1/done").mock(return_value=turn("ended", reason="done"))
    async with httpx.AsyncClient() as http:
        floor = Turns(http, SERVER, request_id="r_1", claim_secret="s3cret", retry_seconds=0)
        started = asyncio.get_running_loop().time()
        async with floor.turn(answering="person", speak=True, max_wait=0.2) as granted:
            assert granted is None
        assert asyncio.get_running_loop().time() - started < 1
    assert done.called


@respx.mock
async def test_a_stray_404_page_after_turns_worked_is_the_floor_out_of_reach_not_gone() -> None:
    respx.post(BASE).mock(
        side_effect=[
            httpx.Response(201, json={"turn": {"id": "t_1", "status": "granted"}}),
            httpx.Response(404, text="<html>tunnel offline</html>"),
            httpx.Response(404, text="404 page not found"),
            httpx.Response(201, json={"turn": {"id": "t_2", "status": "granted"}}),
        ]
    )
    respx.post(url__regex=rf"{BASE}/t_\d/done").mock(return_value=turn("ended", reason="done"))
    async with httpx.AsyncClient() as http:
        floor = turns(http)
        async with floor.turn(answering="agent", speak=False) as granted:
            assert granted is not None
        async with floor.turn(answering="agent", speak=False) as granted:
            assert granted is None  # not a free pass to talk over other agents
        async with floor.turn(answering="person", speak=False) as granted:
            assert granted is LOCAL
        assert floor.supported is True
        async with floor.turn(answering="agent", speak=False) as granted:
            assert granted is not None and granted is not LOCAL
