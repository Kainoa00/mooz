"""Meeting notes in the agent: consent from the room, commands from the owner only."""

import asyncio
import json
from pathlib import Path

import pytest

from mooz_agent.agent import Agent
from mooz_agent.brain import ToolLoopBrain
from mooz_agent.config import AgentConfig
from mooz_agent.memory import MemoryStore
from mooz_agent.notes import NOTES_TAG
from mooz_agent.providers.fakes import FakeSTT, FakeTTS, OfflineModel
from mooz_agent.room import Speaker
from mooz_agent.tools.toolbox import ToolBox

from .test_agent import KAI, ZACH, FakeRoom, hear

pytestmark = pytest.mark.unit

ON = {"type": "notes", "state": "on"}
OFF = {"type": "notes", "state": "off"}


class NotesRoom(FakeRoom):
    def __init__(self, allowed: bool = True) -> None:
        super().__init__()
        self.allowed = allowed
        self.opted_out: set[str] = set()
        self.signals: list[tuple[dict[str, object], list[str] | None]] = []
        self.on_participant_joined = None
        self.on_notes_policy_changed = None

    def notes_allowed(self) -> bool:
        return self.allowed

    def is_opted_out(self, identity: str) -> bool:
        return identity in self.opted_out

    async def send_signal(self, message: dict[str, object], to: list[str] | None = None) -> None:
        self.signals.append((message, to))


def make(tmp_path: Path, allowed: bool = True) -> tuple[NotesRoom, Agent, MemoryStore]:
    memory = MemoryStore(tmp_path / "memory.jsonl")
    brain = ToolLoopBrain(
        model=OfflineModel(),
        agent_name="Atlas",
        owner_name="Kainoa",
        owner_identity=KAI.identity,
        toolbox=ToolBox(AgentConfig(name="Atlas"), memory, owner_name="Kainoa"),
        memory=memory,
    )
    room = NotesRoom(allowed)
    agent = Agent(room=room, stt=FakeSTT({}), tts=FakeTTS(), brain=brain)  # type: ignore[arg-type]
    agent.late_joiner_delay = 0
    agent.wire()
    return room, agent, memory


def notes(memory: MemoryStore) -> list[str]:
    return [n.text for n in memory.all(owner=True) if NOTES_TAG in n.tags]


async def test_refuses_when_the_host_has_not_allowed_notes(tmp_path: Path) -> None:
    room, agent, _ = make(tmp_path, allowed=False)
    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    assert "host hasn't allowed" in room.sent[-1]
    assert room.signals == [] and agent.notes is not None and not agent.notes.active


async def test_only_the_owner_can_start_or_stop_notes(tmp_path: Path) -> None:
    room, agent, _ = make(tmp_path)
    hear(agent, ZACH, "Atlas, keep notes")
    await agent.idle()
    assert "Only Kainoa" in room.sent[-1] and room.signals == []

    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    hear(agent, ZACH, "Atlas, stop keeping notes")
    await agent.idle()
    assert "Only Kainoa" in room.sent[-1]
    assert agent.notes is not None and agent.notes.active
    await agent.aclose()


async def test_announces_to_everyone_and_to_late_joiners(tmp_path: Path) -> None:
    room, agent, _ = make(tmp_path)
    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    assert room.signals == [(ON, None)]
    assert any(m.startswith("📝 Kainoa's Atlas is keeping notes") for m in room.sent)

    assert room.on_participant_joined is not None
    room.on_participant_joined(Speaker("p_new", "Lee", "human"))
    await asyncio.sleep(0.01)
    assert room.signals[-1] == (ON, ["p_new"])
    await agent.aclose()


async def test_saves_notes_without_opted_out_people(tmp_path: Path) -> None:
    room, agent, memory = make(tmp_path)
    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    hear(agent, ZACH, "my salary is ninety thousand")
    room.opted_out.add(ZACH.identity)  # opting out mid-meeting covers what they already said
    hear(agent, ZACH, "and I live on Main Street")
    hear(agent, KAI, "we ship the beta on Friday")
    hear(agent, KAI, "Atlas, stop keeping notes")
    await agent.idle()

    [saved] = notes(memory)
    assert "we ship the beta on Friday" in saved
    assert "ninety" not in saved and "Main Street" not in saved
    assert room.signals[-1] == (OFF, None)
    assert agent.notes is not None and not agent.notes.active


async def test_stops_when_the_host_turns_notes_off(tmp_path: Path) -> None:
    room, agent, memory = make(tmp_path)
    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    hear(agent, KAI, "the launch moved to March")

    room.allowed = False
    assert room.on_notes_policy_changed is not None
    room.on_notes_policy_changed()
    await agent.idle()

    assert agent.notes is not None and not agent.notes.active
    assert room.signals[-1] == (OFF, None)
    assert any("host turned off agent notes" in m for m in room.sent)
    assert any("launch moved to March" in n for n in notes(memory))


async def test_saves_periodically_and_when_the_meeting_ends(tmp_path: Path) -> None:
    _, agent, memory = make(tmp_path)
    agent.notes_interval = 0.05
    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    hear(agent, KAI, "first chunk of the meeting")
    await asyncio.sleep(0.2)
    assert any("first chunk" in n for n in notes(memory))

    hear(agent, KAI, "last words before everyone leaves")
    await agent.aclose()
    assert any("last words" in n for n in notes(memory))


async def test_already_on_and_not_on(tmp_path: Path) -> None:
    room, agent, _ = make(tmp_path)
    hear(agent, KAI, "Atlas, stop keeping notes")
    await agent.idle()
    assert "not keeping notes" in room.sent[-1]
    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    assert "already keeping notes" in room.sent[-1]
    assert [s for s, _ in room.signals] == [ON]
    await agent.aclose()


def test_signals_are_small_json() -> None:
    assert json.loads(json.dumps(ON)) == {"type": "notes", "state": "on"}
