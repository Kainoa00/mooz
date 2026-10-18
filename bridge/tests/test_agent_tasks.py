"""Background research in the agent: owner-only, keeps listening, reports back at a pause."""

import asyncio
from pathlib import Path

import pytest

from mooz_agent.agent import Agent
from mooz_agent.brain import ToolLoopBrain
from mooz_agent.config import AgentConfig
from mooz_agent.memory import TASK_RESULT_TAG, MemoryStore
from mooz_agent.notes import NOTES_TAG
from mooz_agent.providers import fakes
from mooz_agent.providers.fakes import FakeSTT, FakeTTS, OfflineModel
from mooz_agent.room import Speaker
from mooz_agent.tools.toolbox import ToolBox

from .test_agent import KAI, ZACH, hear
from .test_agent_notes import NotesRoom

pytestmark = pytest.mark.unit

LEE = Speaker("p_lee", "Lee", "human")


class TasksRoom(NotesRoom):
    def __init__(self) -> None:
        super().__init__()
        self.people = [KAI, ZACH]
        self.task_events: list[tuple[dict[str, object], list[str] | None]] = []
        self.chat_to: list[list[str] | None] = []

    async def send_chat(
        self,
        text: str,
        reply_to: str | None = None,
        sources: frozenset[str] = frozenset(),
        to: list[str] | None = None,
    ) -> None:
        await super().send_chat(text, reply_to, sources, to)
        self.chat_to.append(to)

    async def send_task_event(
        self, message: dict[str, object], to: list[str] | None = None
    ) -> None:
        self.task_events.append((message, to))

    def events_for(self, identity: str) -> list[dict[str, object]]:
        return [m for m, to in self.task_events if to is None or identity in to]

    def events_for_only(self, identity: str) -> list[dict[str, object]]:
        return [m for m, to in self.task_events if to == [identity]]


@pytest.fixture
def setup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[TasksRoom, Agent, FakeTTS, MemoryStore]:
    monkeypatch.setattr(fakes, "SLOW_SECONDS", 0.3)
    plans = tmp_path / "plans"
    plans.mkdir()
    (plans / "launch.md").write_text("The launch is on March 30th.\n")
    config = AgentConfig(name="Atlas")
    config.add_source(plans, label="plans")
    memory = MemoryStore(tmp_path / "memory.jsonl")
    brain = ToolLoopBrain(
        model=OfflineModel(),
        agent_name="Atlas",
        owner_name="Kainoa",
        owner_identity=KAI.identity,
        toolbox=ToolBox(config, memory, owner_name="Kainoa"),
        memory=memory,
    )
    room, tts = TasksRoom(), FakeTTS()
    agent = Agent(room=room, stt=FakeSTT({}), tts=tts, brain=brain)  # type: ignore[arg-type]
    agent.late_joiner_delay = 0
    agent.task_list_interval = 0
    agent.quiet_seconds = 0.05
    agent.wire()
    return room, agent, tts, memory


async def finish(agent: Agent) -> None:
    """Let the reply start the task, the task finish, and the report go out."""
    assert agent.tasks is not None
    await agent.idle()
    await agent.tasks.idle()
    await agent.idle()


async def test_the_owner_starts_a_task_and_hears_back(setup) -> None:  # type: ignore[no-untyped-def]
    room, agent, tts, memory = setup
    hear(agent, KAI, "Atlas, look into the launch")
    await finish(agent)

    assert room.sent[0].startswith("On it")
    states = [e["state"] for e in room.events_for("p_z")]
    assert states[0] == "queued" and "working" in states and states[-1] == "done"
    assert any(e["progress"] for e in room.events_for("p_z"))
    report = next(m for m in room.sent if m.startswith("📋"))
    assert "Look into the launch" in report and "March 30th" in report
    assert room.replies[room.sent.index(report)] == KAI.identity
    assert any(s.startswith("Kainoa, about the launch:") for s in tts.spoken)
    [saved] = [n for n in memory.all(owner=True) if TASK_RESULT_TAG in n.tags]
    assert "March 30th" in saved.text and not saved.public


async def test_only_the_owner_starts_or_stops_tasks(setup) -> None:  # type: ignore[no-untyped-def]
    room, agent, _, _ = setup
    hear(agent, ZACH, "Atlas, look into the launch")
    await agent.idle()
    assert "Only Kainoa can ask me to research" in room.sent[-1]
    assert room.task_events == []

    hear(agent, KAI, "Atlas, look into the launch slowly")
    await agent.idle()
    hear(agent, ZACH, "Atlas, stop that")
    await agent.idle()
    assert "Only Kainoa can stop" in room.sent[-1]
    assert agent.tasks is not None and agent.tasks.latest_active() is not None
    await agent.aclose()


async def test_it_keeps_answering_while_a_task_runs(setup) -> None:  # type: ignore[no-untyped-def]
    room, agent, _, _ = setup
    hear(agent, KAI, "Atlas, look into the launch slowly")
    await agent.idle()
    hear(agent, ZACH, "Atlas, what is 2+2?")
    await agent.idle()
    assert room.sent[-1] == "You asked: what is 2+2?"
    assert agent.tasks is not None and agent.tasks.latest_active() is not None
    await agent.aclose()


async def test_the_spoken_report_waits_while_someone_is_talking(setup) -> None:  # type: ignore[no-untyped-def]
    room, agent, tts, _ = setup
    room.speaking = True  # someone is mid-sentence (no transcript line yet)
    hear(agent, KAI, "Atlas, look into the launch")
    await agent.idle()
    assert agent.tasks is not None
    await agent.tasks.idle()
    await asyncio.sleep(0.3)
    assert any(m.startswith("📋") for m in room.sent)  # chat already has it
    assert not any(s.startswith("Kainoa, about") for s in tts.spoken)
    room.speaking = False
    await agent.idle()
    assert any(s.startswith("Kainoa, about") for s in tts.spoken)


async def test_the_spoken_report_waits_for_a_pause_after_someone_spoke(setup) -> None:  # type: ignore[no-untyped-def]
    _, agent, tts, _ = setup
    agent.quiet_seconds = 60.0  # Kainoa just spoke, and that counts for a minute
    hear(agent, KAI, "Atlas, look into the launch")
    await agent.idle()
    assert agent.tasks is not None
    await agent.tasks.idle()
    await asyncio.sleep(0.2)
    assert not any(s.startswith("Kainoa, about") for s in tts.spoken)
    agent.quiet_seconds = 0.01
    await agent.idle()
    assert any(s.startswith("Kainoa, about") for s in tts.spoken)


async def test_private_results_reach_only_the_owner(setup) -> None:  # type: ignore[no-untyped-def]
    room, agent, tts, _ = setup
    hear(agent, KAI, "Atlas, look into the launch privately")
    await finish(agent)

    report = next(m for m in room.sent if m.startswith("📋"))
    assert room.chat_to[room.sent.index(report)] == [KAI.identity]
    assert not any(s.startswith("Kainoa, about") for s in tts.spoken)
    mine = room.events_for(KAI.identity)
    theirs = [m for m, to in room.task_events if to is not None and ZACH.identity in to]
    assert mine[-1]["title"] == "Look into the launch" and "March 30th" in str(mine[-1]["details"])
    assert theirs and all(e["title"] == "Private task" and e["details"] == "" for e in theirs)
    assert all(to is not None for _, to in room.task_events)  # never broadcast


async def test_cancelling_by_voice_and_from_the_panel(setup) -> None:  # type: ignore[no-untyped-def]
    room, agent, _, _ = setup
    hear(agent, KAI, "Atlas, look into the launch slowly")
    await agent.idle()
    hear(agent, KAI, "Atlas, stop that")
    await finish(agent)
    assert "stopped" in room.sent[-1]
    assert room.events_for("p_z")[-1]["state"] == "cancelled"

    hear(agent, KAI, "Atlas, research the launch slowly")
    await agent.idle()
    task = room.events_for("p_z")[-1]
    assert room.on_signal is not None
    room.on_signal(ZACH, {"type": "task.cancel", "id": task["id"]})  # not the owner: ignored
    await agent.idle()
    assert room.events_for("p_z")[-1]["state"] == "working"
    room.on_signal(KAI, {"type": "task.cancel", "id": task["id"]})
    await finish(agent)
    assert room.events_for("p_z")[-1]["state"] == "cancelled"


async def test_status_questions_and_late_joiners(setup) -> None:  # type: ignore[no-untyped-def]
    room, agent, _, _ = setup
    hear(agent, KAI, "Atlas, look into the launch slowly")
    hear(agent, KAI, "Atlas, investigate the budget slowly, just for me")
    await agent.idle()

    hear(agent, ZACH, "Atlas, what are you working on?")
    await agent.idle()
    assert "Look into the launch slowly" in room.sent[-1] and "budget" not in room.sent[-1]
    assert "private task" in room.sent[-1]
    # Said to the room, even the owner's status keeps private tasks private...
    hear(agent, KAI, "Atlas, what are you working on?")
    await agent.idle()
    assert "budget" not in room.sent[-1] and "Ask me privately" in room.sent[-1]
    # ...and asked privately, the details go only to them.
    hear(agent, KAI, "Atlas, what are you working on, privately?")
    await agent.idle()
    assert "Investigate the budget slowly" in room.sent[-1] and room.sent[-1].startswith("🔒")
    assert room.chat_to[-1] == [KAI.identity]

    room.task_events.clear()
    assert room.on_signal is not None
    room.on_signal(LEE, {"type": "tasks?"})
    await agent.idle()
    assert {e["title"] for e, to in room.task_events if to == [LEE.identity]} == {
        "Look into the launch slowly",
        "Private task",
    }
    room.on_signal(KAI, {"type": "tasks?"})
    await agent.idle()
    titles = {str(e["title"]) for e, to in room.task_events if to == [KAI.identity]}
    assert "Investigate the budget slowly" in titles

    # A browser's own query can arrive before the agent has seen it join, so it's told anyway.
    room.task_events.clear()
    assert room.on_participant_joined is not None
    room.on_participant_joined(LEE)
    await agent.idle()
    assert {e["title"] for e, to in room.task_events if to == [LEE.identity]} == {
        "Look into the launch slowly",
        "Private task",
    }
    await agent.aclose()


async def test_an_overflowing_owner_question_carries_on_as_a_task(setup) -> None:  # type: ignore[no-untyped-def]
    _, agent, _, _ = setup
    brain = agent.brain
    assert isinstance(brain, ToolLoopBrain) and brain.on_overflow is not None

    said = brain.on_overflow("when is the launch?", KAI, "read_file: The launch is on March 30th.")
    await finish(agent)

    assert said.startswith("This needs more digging")
    assert agent.tasks is not None
    [task] = agent.tasks.tasks
    assert task.title == "When is the launch?" and "March 30th" in task.context


async def test_the_meeting_ending_finishes_and_saves_the_work(setup) -> None:  # type: ignore[no-untyped-def]
    _, agent, _, memory = setup
    hear(agent, KAI, "Atlas, look into the launch slowly")
    await agent.idle()
    await agent.aclose(finish_tasks=True)
    assert any(TASK_RESULT_TAG in n.tags and "March 30th" in n.text for n in memory.all(owner=True))


async def test_ctrl_c_stops_at_once_and_still_saves_the_notes(  # type: ignore[no-untyped-def]
    setup, monkeypatch: pytest.MonkeyPatch
) -> None:
    room, agent, _, memory = setup
    monkeypatch.setattr(fakes, "SLOW_SECONDS", 30.0)
    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    hear(agent, ZACH, "the launch moves to April")
    hear(agent, KAI, "Atlas, look into the launch slowly")
    await agent.idle()
    assert agent.tasks is not None and agent.tasks.latest_active() is not None

    await asyncio.wait_for(agent.aclose(), 2)  # doesn't wait out the 30-second task

    assert agent.tasks.latest_active() is None
    assert any(NOTES_TAG in n.tags and "April" in n.text for n in memory.all(owner=True))
    sent = len(room.sent)
    hear(agent, KAI, "Atlas, what is 2+2?")  # leaving: no more answers
    await agent.idle()
    assert len(room.sent) == sent


async def test_a_private_question_is_answered_only_to_the_owner(setup) -> None:  # type: ignore[no-untyped-def]
    room, agent, tts, _ = setup
    hear(agent, KAI, "Atlas, privately, what is 2+2?")
    await agent.idle()
    assert room.sent[-1].startswith("🔒") and room.chat_to[-1] == [KAI.identity]
    assert tts.spoken == []  # never out loud
    rendered = agent.transcript.render()
    assert "You asked" not in rendered  # nor in the transcript later answers and notes use

    hear(agent, ZACH, "Atlas, privately, what is 2+2?")  # guests only ever get public answers
    await agent.idle()
    assert room.chat_to[-1] is None


async def test_an_overflowing_private_question_stays_private(setup) -> None:  # type: ignore[no-untyped-def]
    _, agent, _, _ = setup
    brain = agent.brain
    assert isinstance(brain, ToolLoopBrain) and brain.on_overflow is not None
    brain.on_overflow("when is the launch? just for me", KAI, "")
    await finish(agent)
    assert agent.tasks is not None
    [task] = agent.tasks.tasks
    assert task.private and task.title == "When is the launch?"


async def test_task_lists_go_out_at_most_once_per_interval(setup) -> None:  # type: ignore[no-untyped-def]
    room, agent, _, _ = setup
    agent.task_list_interval = 0.3
    hear(agent, KAI, "Atlas, look into the launch slowly")
    await agent.idle()
    room.task_events.clear()
    assert room.on_signal is not None
    for _ in range(20):
        room.on_signal(LEE, {"type": "tasks?"})
    await agent.idle()
    assert len(room.events_for_only(LEE.identity)) == 1
    room.on_signal(LEE, {"type": "tasks?"})  # too soon: it waits, but still comes
    await agent.idle()
    assert len(room.events_for_only(LEE.identity)) == 2
    await agent.aclose()


async def test_notes_opt_outs_cover_task_reports(setup) -> None:  # type: ignore[no-untyped-def]
    room, agent, _, memory = setup
    hear(agent, KAI, "Atlas, keep notes")
    await agent.idle()
    hear(agent, ZACH, "my salary is ninety thousand")
    hear(agent, KAI, "Atlas, look into the launch")  # the meeting so far goes into the task
    await finish(agent)
    room.opted_out.add(ZACH.identity)
    hear(agent, KAI, "Atlas, stop keeping notes")
    await agent.idle()
    [saved] = [n.text for n in memory.all(owner=True) if NOTES_TAG in n.tags]
    assert "what I found about launch" not in saved  # the report drew on Zach's words
    assert "ninety" not in saved
    assert "look into the launch" in saved  # Kainoa's own words stay
