import asyncio
from collections.abc import AsyncIterator

import pytest

from mooz_agent.listening import Listener
from mooz_agent.providers.fakes import FakeSTT
from mooz_agent.room import Speaker
from mooz_agent.transcript import Utterance

pytestmark = pytest.mark.unit

ZACH = Speaker("p_z", "Zach", "human")
KAI = Speaker("p_k", "Kainoa", "human")


async def frames(n: int) -> AsyncIterator[bytes]:
    for _ in range(n):
        yield b"\x00\x00"
        await asyncio.sleep(0)


async def settle() -> None:
    for _ in range(20):
        await asyncio.sleep(0)


async def test_attributes_each_transcript_to_its_track_owner() -> None:
    heard: list[Utterance] = []
    stt = FakeSTT({"p_z": ["what is blocking the deploy"], "p_k": ["hey Atlas"]})
    listener = Listener(stt, heard.append)

    listener.attach(ZACH, frames(3))
    listener.attach(KAI, frames(3))
    await settle()

    assert sorted((u.speaker.name, u.text, u.via) for u in heard) == [
        ("Kainoa", "hey Atlas", "voice"),
        ("Zach", "what is blocking the deploy", "voice"),
    ]
    await listener.aclose()


async def test_drops_empty_transcripts() -> None:
    heard: list[Utterance] = []
    listener = Listener(FakeSTT({"p_z": ["", "  ", "ok"]}), heard.append)

    listener.attach(ZACH, frames(1))
    await settle()

    assert [u.text for u in heard] == ["ok"]
    await listener.aclose()


async def test_detach_stops_transcribing_that_speaker() -> None:
    heard: list[Utterance] = []
    stt = FakeSTT({"p_z": ["one", "two"]}, delay=0.01)
    listener = Listener(stt, heard.append)

    listener.attach(ZACH, frames(100))
    listener.detach("p_z")
    await asyncio.sleep(0.05)

    assert heard == []
    assert listener.active == set()


async def test_reattaching_replaces_the_old_stream() -> None:
    stt = FakeSTT({"p_z": []})
    listener = Listener(stt, lambda _u: None)

    listener.attach(ZACH, frames(100))
    listener.attach(ZACH, frames(100))

    assert listener.active == {"p_z"}
    await listener.aclose()
    assert listener.active == set()


async def test_one_failing_stream_does_not_stop_the_others() -> None:
    heard: list[Utterance] = []
    stt = FakeSTT({"p_z": RuntimeError("boom"), "p_k": ["still here"]})
    listener = Listener(stt, heard.append)

    listener.attach(ZACH, frames(1))
    listener.attach(KAI, frames(1))
    await settle()

    assert [u.text for u in heard] == ["still here"]
    await listener.aclose()
