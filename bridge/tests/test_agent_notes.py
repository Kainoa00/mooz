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
from mooz_agent.room import ChatMessage, Speaker
from mooz_agent.tools.toolbox import ToolBox

from .test_agent import GROK, KAI, ZACH, FakeRoom, hear

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
        self.flip_policy_on_signal = False
        self.during_on_broadcast = None

    def notes_allowed(self) -> bool:
        return self.allowed

    def is_opted_out(self, identity: str) -> bool:
        return identity in self.opted_out

    async def send_signal(self, message: dict[str, object], to: list[str] | None = None) -> None:
        self.signals.append((message, to))
        if message == ON and to is None:
            if self.flip_policy_on_signal:
                self.allowed = False
            if self.during_on_broadcast:
                self.during_on_broadcast()
                await asyncio.sleep(0)  # let what arrived meanwhile run


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
    room.people = [KAI, ZACH]
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


class SlowSummaries(ToolLoopBrain):
    async def summarize(self, *, transcript: str) -> str:
        await asyncio.sleep(0.2)
        return await super().summarize(transcript=transcript)


class TranscriptSpy(ToolLoopBrain):
    seen: list[str]

    async def answer(self, *, question: str, asker: Speaker, transcript: str):  # type: ignore[no-untyped-def]
        self.seen = [*getattr(self, "seen", []), transcript]
        return await super().answer(question=question, asker=asker, transcript=transcript)


def make_with(
    brain_type: type[ToolLoopBrain], tmp_path: Path
) -> tuple[NotesRoom, Agent, MemoryStore]:
    memory = MemoryStore(tmp_path / "memory.jsonl")
    brain = brain_type(
        model=OfflineModel(),
        agent_name="Atlas",
        owner_name="Kainoa",
        owner_identity=KAI.identity,
        toolbox=ToolBox(AgentConfig(name="Atlas"), memory, owner_name="Kainoa"),
        memory=memory,
    )
    room = NotesRoom()
    room.people = [KAI, ZACH]
    agent = Agent(room=room, stt=FakeSTT({}), tts=FakeTTS(), brain=brain)  # type: ignore[arg-type]
    agent.late_joiner_delay = 0
    agent.wire()
    return room, agent, memory


async def test_answers_to_opted_out_people_stay_out_of_notes(tmp_path: Path) -> None:
    room, agent, memory = make(tmp_path)
    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    room.opted_out.add(ZACH.identity)
    hear(agent, ZACH, "Atlas, my hearing is on Friday?", via="chat")
    await agent.idle()
    assert room.replies[-1] == ZACH.identity  # the chat reply says whom it answers
    hear(agent, KAI, "Atlas, stop keeping notes")
    await agent.idle()
    [saved] = notes(memory)
    assert "hearing" not in saved


async def test_other_agents_replies_to_opted_out_people_stay_out(tmp_path: Path) -> None:
    room, agent, memory = make(tmp_path)
    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    room.opted_out.add(ZACH.identity)
    assert room.on_chat is not None
    room.on_chat(ChatMessage(GROK, "Zach's appointment is at 3", 1.0, about=ZACH.identity))
    hear(agent, KAI, "Atlas, stop keeping notes")
    await agent.idle()
    assert all("appointment" not in n for n in notes(memory))


async def test_while_notes_are_on_answers_ignore_opted_out_people(tmp_path: Path) -> None:
    room, agent, _ = make_with(TranscriptSpy, tmp_path)
    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    room.opted_out.add(ZACH.identity)
    hear(agent, ZACH, "my salary is ninety thousand")
    hear(agent, KAI, "Atlas, what did everyone say?")
    await agent.idle()
    brain = agent.brain
    assert isinstance(brain, TranscriptSpy)
    assert "ninety" not in brain.seen[-1]
    await agent.aclose()


async def test_notes_dont_start_if_the_host_turns_them_off_meanwhile(tmp_path: Path) -> None:
    room, agent, _ = make(tmp_path)
    room.flip_policy_on_signal = True  # the host unticks while the announcement is going out
    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    assert agent.notes is not None and not agent.notes.active
    assert [s for s, _ in room.signals] == [ON, OFF]
    assert "host" in room.sent[-1]


async def test_notes_survive_shutdown_in_the_middle_of_stopping(tmp_path: Path) -> None:
    room, agent, memory = make_with(SlowSummaries, tmp_path)
    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    hear(agent, KAI, "the budget is approved")
    room.allowed = False
    assert room.on_notes_policy_changed is not None
    room.on_notes_policy_changed()  # starts stopping, with a slow summary
    await asyncio.sleep(0.05)
    await agent.aclose()  # the meeting ends before that summary is written
    assert any("budget is approved" in n for n in notes(memory))


async def test_newcomers_are_kept_only_after_they_are_told(tmp_path: Path) -> None:
    room, agent, memory = make_with(ToolLoopBrain, tmp_path)
    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    lee = Speaker("p_lee", "Lee", "human")
    hear(agent, lee, "hi I'm brand new")  # joined but not told yet
    assert room.on_participant_joined is not None
    room.on_participant_joined(lee)
    await agent.idle()
    hear(agent, lee, "glad to be here")
    hear(agent, ZACH, "present at the start")
    hear(agent, KAI, "Atlas, stop keeping notes")
    await agent.idle()
    [saved] = notes(memory)
    assert "brand new" not in saved
    assert "glad to be here" in saved and "present at the start" in saved


async def test_browsers_can_ask_whether_notes_are_on(tmp_path: Path) -> None:
    room, agent, _ = make_with(ToolLoopBrain, tmp_path)
    lee = Speaker("p_lee", "Lee", "human")
    assert room.on_signal is not None
    room.on_signal(lee, {"type": "notes?"})
    await agent.idle()
    assert room.signals[-1] == (OFF, ["p_lee"])

    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    room.on_signal(lee, {"type": "notes?"})
    room.on_signal(GROK, {"type": "notes?"})  # agents don't need telling
    await agent.idle()
    assert room.signals[-1] == (ON, ["p_lee"])
    await agent.aclose()


async def test_replies_drawing_on_someone_who_later_opts_out_are_dropped(tmp_path: Path) -> None:
    room, agent, memory = make(tmp_path)
    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    hear(agent, ZACH, "my salary is ninety thousand")
    hear(agent, KAI, "Atlas, what did Zach say?", via="chat")
    await agent.idle()
    assert ZACH.identity in room.sources[-1]  # the reply says whose words it may contain
    assert room.on_chat is not None
    room.on_chat(
        ChatMessage(
            GROK, "Zach earns a lot", 1.0, about=KAI.identity, sources=frozenset({ZACH.identity})
        )
    )
    room.opted_out.add(ZACH.identity)  # opts out only afterwards
    hear(agent, KAI, "Atlas, stop keeping notes")
    await agent.idle()
    [saved] = notes(memory)
    assert "You asked: what did Zach say" not in saved  # the reply that could quote him
    assert "earns" not in saved and "ninety" not in saved
    assert "Atlas, what did Zach say?" in saved  # Kainoa's own question stays


async def test_someone_asking_during_the_announcement_is_told_notes_are_on(tmp_path: Path) -> None:
    room, agent, memory = make(tmp_path)
    lee = Speaker("p_lee", "Lee", "human")
    room.during_on_broadcast = lambda: room.on_signal(lee, {"type": "notes?"})  # type: ignore[misc]
    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    assert (ON, ["p_lee"]) in room.signals
    hear(agent, lee, "count me in")
    hear(agent, KAI, "Atlas, stop keeping notes")
    await agent.idle()
    assert any("count me in" in n for n in notes(memory))


async def test_notes_cant_restart_while_the_last_ones_are_saving(tmp_path: Path) -> None:
    room, agent, memory = make_with(SlowSummaries, tmp_path)
    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    hear(agent, KAI, "first session")
    hear(agent, KAI, "Atlas, stop keeping notes")
    await asyncio.sleep(0.05)  # stopping, waiting on a slow summary
    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    assert any("still saving" in m for m in room.sent)
    assert agent.notes is not None and not agent.notes.active
    assert any("first session" in n for n in notes(memory))
