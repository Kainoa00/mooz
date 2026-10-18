"""The whole agent over a real LiveKit room: two people, one private and one public source."""

import asyncio
from pathlib import Path

import pytest
from livekit import rtc

from mooz_agent.agent import Agent
from mooz_agent.config import AgentConfig
from mooz_agent.providers import build_brain
from mooz_agent.providers.fakes import FakeSTT, FakeTTS, OfflineModel
from mooz_agent.room import CHAT_TOPIC, MeetingRoom

from .conftest import LIVEKIT_URL, mint
from .test_room_live import wait_for

pytestmark = pytest.mark.integration


async def join(room_name: str, identity: str, name: str) -> tuple[rtc.Room, list[str]]:
    room = rtc.Room()
    inbox: list[str] = []

    async def read(reader: rtc.TextStreamReader, sender: str) -> None:
        if sender.startswith("a_"):
            inbox.append(await reader.read_all())

    room.register_text_stream_handler(CHAT_TOPIC, lambda r, i: asyncio.ensure_future(read(r, i)))
    await room.connect(LIVEKIT_URL, mint(room_name, identity, name, {"kind": "human"}))
    return room, inbox


async def test_owner_and_guest_get_different_access(
    room_name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MOOZ_HOME", str(tmp_path / "home"))
    (tmp_path / "plans").mkdir()
    (tmp_path / "plans" / "launch.md").write_text("Launch on Friday.\n")
    config = AgentConfig(name="Atlas")
    config.add_source(tmp_path / "plans", label="plans")

    agent_room = MeetingRoom()
    attrs = {"kind": "agent", "owner_id": "p_kai", "owner_name": "Kai"}
    await agent_room.connect(LIVEKIT_URL, mint(room_name, "a_atlas", "Atlas", attrs))
    agent = Agent(
        room=agent_room,
        stt=FakeSTT({}),
        tts=FakeTTS(),
        brain=build_brain(OfflineModel(), agent_room.me, config),
    )
    agent.wire()
    kai, kai_inbox = await join(room_name, "p_kai", "Kai")
    zach, zach_inbox = await join(room_name, "p_zach", "Zach")
    try:
        await wait_for(lambda: len(agent_room.participants()) == 2)
        await zach.local_participant.send_text("@Atlas read launch.md from plans", topic=CHAT_TOPIC)
        await wait_for(lambda: len(zach_inbox) == 1)
        assert "No source called 'plans'" in zach_inbox[0]

        await kai.local_participant.send_text("@Atlas read launch.md from plans", topic=CHAT_TOPIC)
        await wait_for(lambda: len(kai_inbox) == 2)
        assert "Launch on Friday." in kai_inbox[1]
        assert "Launch on Friday." not in zach_inbox[0]
    finally:
        await agent.aclose()
        await kai.disconnect()
        await zach.disconnect()
        await agent_room.disconnect()
