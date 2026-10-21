"""Two agents over a real LiveKit room, taking turns: their voices never overlap."""

import asyncio
import math
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import numpy as np
import pytest
from livekit import rtc

from mooz_agent.agent import Agent
from mooz_agent.providers.fakes import EchoBrain, FakeSTT
from mooz_agent.room import CHAT_TOPIC, MeetingRoom
from mooz_agent.turns import Answering, Granted

from .conftest import LIVEKIT_URL, mint
from .test_room_live import wait_for

pytestmark = pytest.mark.integration


class ToneTTS:
    """A 440 Hz tone, a tenth of a second per word, in real time (as a voice provider streams)."""

    async def synthesize(self, text: str) -> AsyncIterator[rtc.AudioFrame]:
        t = np.arange(480) / 48_000
        tone = (np.sin(2 * math.pi * 440 * t) * 8000).astype(np.int16).tobytes()
        for _word in text.split():
            for _ in range(10):
                yield rtc.AudioFrame(tone, 48_000, 1, 480)


class OneAtATime:
    """The server's floor in miniature: one turn at a time, shared by both agents."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()

    @asynccontextmanager
    async def turn(
        self, *, answering: Answering, speak: bool, max_wait: float | None = None
    ) -> AsyncIterator[Granted | None]:
        async with self._lock:
            yield Granted(deadline=time.monotonic() + 45)


class Listener:
    """A person who notes when each agent's voice is heard."""

    def __init__(self) -> None:
        self.room = rtc.Room()
        self.heard: dict[str, list[float]] = {}
        self._reads: set[asyncio.Task[None]] = set()

    async def join(self, room_name: str) -> None:
        def subscribed(track: rtc.Track, _pub: object, who: rtc.RemoteParticipant) -> None:
            if track.kind == rtc.TrackKind.KIND_AUDIO:
                task = asyncio.ensure_future(self._listen(who.identity, track))
                self._reads.add(task)

        self.room.on("track_subscribed", subscribed)
        await self.room.connect(LIVEKIT_URL, mint(room_name, "p_kai", "Kai", {"kind": "human"}))

    async def _listen(self, identity: str, track: rtc.Track) -> None:
        async for event in rtc.AudioStream(track):
            samples = np.frombuffer(event.frame.data, dtype=np.int16)
            if samples.size and int(np.abs(samples).max()) > 1000:
                self.heard.setdefault(identity, []).append(time.monotonic())

    def spans(self) -> list[tuple[str, float, float]]:
        return [(who, min(times), max(times)) for who, times in self.heard.items() if times]

    async def aclose(self) -> None:
        for task in self._reads:
            task.cancel()
        await self.room.disconnect()


async def test_two_agents_answer_one_at_a_time(room_name: str) -> None:
    floor = OneAtATime()
    rooms: list[MeetingRoom] = []
    agents: list[Agent] = []
    for identity, name in (("a_atlas", "Atlas"), ("a_nova", "Nova")):
        room = MeetingRoom()
        attrs = {"kind": "agent", "owner_id": "p_kai", "owner_name": "Kai"}
        await room.connect(LIVEKIT_URL, mint(room_name, identity, name, attrs))
        agent = Agent(room=room, stt=FakeSTT({}), tts=ToneTTS(), brain=EchoBrain(), turns=floor)
        agent.wire()
        rooms.append(room)
        agents.append(agent)
    kai = Listener()
    await kai.join(room_name)
    try:
        await wait_for(lambda: all(len(r.participants()) == 2 for r in rooms))
        await kai.room.local_participant.send_text(
            "@Atlas @Nova what do you both think about the launch plan", topic=CHAT_TOPIC
        )
        await wait_for(lambda: len(kai.heard) == 2, 20)
        await asyncio.sleep(2.0)  # let the second one finish
        (_, a_start, a_end), (_, b_start, b_end) = sorted(kai.spans(), key=lambda s: s[1])
        assert a_end < b_start, f"voices overlapped: {kai.spans()}"
        assert a_end - a_start > 0.5 and b_end - b_start > 0.5  # each said its whole answer
    finally:
        await kai.aclose()
        for agent, room in zip(agents, rooms, strict=True):
            await agent.aclose()
            await room.disconnect()
