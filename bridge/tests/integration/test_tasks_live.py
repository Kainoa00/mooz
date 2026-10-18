"""Background tasks over a real LiveKit room: who sees what, and who may cancel."""

import asyncio
import json
from pathlib import Path

import pytest
from livekit import rtc

from mooz_agent.agent import Agent
from mooz_agent.config import AgentConfig
from mooz_agent.providers import build_brain, fakes
from mooz_agent.providers.fakes import FakeSTT, FakeTTS, OfflineModel
from mooz_agent.room import CHAT_TOPIC, MOOZ_TOPIC, TASKS_TOPIC, MeetingRoom

from .conftest import LIVEKIT_URL, mint
from .test_room_live import wait_for

pytestmark = pytest.mark.integration


class Person:
    def __init__(self) -> None:
        self.room = rtc.Room()
        self.events: list[dict[str, object]] = []
        self.chat: list[str] = []
        self._reads: set[asyncio.Task[None]] = set()

    def _keep(self, coro) -> None:  # type: ignore[no-untyped-def]
        task = asyncio.ensure_future(coro)
        self._reads.add(task)
        task.add_done_callback(self._reads.discard)

    async def join(self, room_name: str, identity: str, name: str) -> None:
        def on_task(reader: rtc.TextStreamReader, sender: str) -> None:
            async def read() -> None:
                self.events.append(json.loads(await reader.read_all()))

            self._keep(read())

        def on_chat(reader: rtc.TextStreamReader, sender: str) -> None:
            async def read() -> None:
                if sender.startswith("a_"):
                    self.chat.append(await reader.read_all())

            self._keep(read())

        self.room.register_text_stream_handler(TASKS_TOPIC, on_task)
        self.room.register_text_stream_handler(CHAT_TOPIC, on_chat)
        await self.room.connect(LIVEKIT_URL, mint(room_name, identity, name, {"kind": "human"}))

    async def say(self, text: str) -> None:
        await self.room.local_participant.send_text(text, topic=CHAT_TOPIC)

    async def signal(self, message: dict[str, object]) -> None:
        await self.room.local_participant.publish_data(
            json.dumps(message), reliable=True, topic=MOOZ_TOPIC
        )

    def last(self, title: str) -> dict[str, object] | None:
        matching = [e for e in self.events if e["title"] == title]
        return max(matching, key=lambda e: int(e["seq"])) if matching else None  # type: ignore[call-overload]


async def test_private_tasks_and_cancelling_over_livekit(
    room_name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MOOZ_HOME", str(tmp_path / "home"))
    monkeypatch.setattr(fakes, "SLOW_SECONDS", 20.0)
    (tmp_path / "plans").mkdir()
    (tmp_path / "plans" / "launch.md").write_text("The launch is on March 30th.\n")
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
    kai, zach = Person(), Person()
    await kai.join(room_name, "p_kai", "Kai")
    await zach.join(room_name, "p_zach", "Zach")
    try:
        await wait_for(lambda: len(agent_room.participants()) == 2)

        # A private task: the owner sees everything, the other person only that it exists.
        await kai.say("@Atlas look into the launch privately")
        await wait_for(lambda: (kai.last("Look into the launch") or {}).get("state") == "done", 20)
        mine = kai.last("Look into the launch")
        assert mine is not None and "March 30th" in str(mine["details"])
        await wait_for(lambda: any(m.startswith("📋") for m in kai.chat))
        await asyncio.sleep(0.5)
        assert zach.last("Look into the launch") is None
        theirs = zach.last("Private task")
        assert theirs is not None and theirs["details"] == "" and theirs["progress"] == []
        assert not any(m.startswith("📋") for m in zach.chat)

        # A public task that only its owner can cancel, from the panel.
        await kai.say("@Atlas research the launch slowly")
        await wait_for(
            lambda: (zach.last("Research the launch slowly") or {}).get("state") == "working"
        )
        task_id = zach.last("Research the launch slowly")["id"]  # type: ignore[index]
        await zach.signal({"type": "task.cancel", "id": task_id})
        await asyncio.sleep(1.0)
        assert zach.last("Research the launch slowly")["state"] == "working"  # type: ignore[index]
        await kai.signal({"type": "task.cancel", "id": task_id})
        await wait_for(
            lambda: (zach.last("Research the launch slowly") or {}).get("state") == "cancelled"
        )

        # Someone joining late asks and is told.
        lee = Person()
        await lee.join(room_name, "p_lee", "Lee")
        # The agent ignores packets from someone it hasn't seen join yet.
        await wait_for(lambda: len(agent_room.participants()) == 3)
        await lee.signal({"type": "tasks?"})
        await wait_for(lambda: lee.last("Research the launch slowly") is not None)
        assert lee.last("Private task") is not None and lee.last("Look into the launch") is None
        await lee.room.disconnect()
    finally:
        await agent.aclose()
        await kai.room.disconnect()
        await zach.room.disconnect()
        await agent_room.disconnect()
