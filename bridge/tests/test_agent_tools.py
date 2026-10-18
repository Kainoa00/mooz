"""The agent with its real tools and memory, driven by the offline model (no network)."""

from pathlib import Path

import pytest

from mooz_agent.agent import FILLER, Agent
from mooz_agent.brain import ToolLoopBrain
from mooz_agent.config import AgentConfig
from mooz_agent.memory import MemoryStore
from mooz_agent.providers.fakes import FakeSTT, FakeTTS, OfflineModel
from mooz_agent.tools.toolbox import ToolBox

from .test_agent import KAI, ME, ZACH, FakeRoom, hear

pytestmark = pytest.mark.unit


@pytest.fixture
def config(tmp_path: Path) -> AgentConfig:
    private = tmp_path / "plans"
    private.mkdir()
    (private / "launch.md").write_text("Launch on Friday with the blue logo.\n")
    public = tmp_path / "site"
    public.mkdir()
    (public / "readme.md").write_text("mooz is a meeting app.\n")
    cfg = AgentConfig(name="Atlas")
    cfg.add_source(private, label="plans")
    cfg.add_source(public, label="site", public=True)
    return cfg


def make(config: AgentConfig, tmp_path: Path) -> tuple[FakeRoom, Agent, FakeTTS, MemoryStore]:
    memory = MemoryStore(tmp_path / "memory.jsonl")
    brain = ToolLoopBrain(
        model=OfflineModel(),
        agent_name="Atlas",
        owner_name="Kainoa",
        owner_identity=KAI.identity,
        toolbox=ToolBox(config, memory, owner_name="Kainoa"),
        memory=memory,
    )
    room, tts = FakeRoom(), FakeTTS()
    agent = Agent(room=room, stt=FakeSTT({}), tts=tts, brain=brain)  # type: ignore[arg-type]
    agent.wire()
    return room, agent, tts, memory


async def test_the_owner_reads_a_private_file(config: AgentConfig, tmp_path: Path) -> None:
    room, agent, _, _ = make(config, tmp_path)
    hear(agent, KAI, "Atlas, read launch.md from plans")
    await agent.idle()
    assert "Launch on Friday with the blue logo." in room.sent[-1]


async def test_a_guest_cannot_read_a_private_source(config: AgentConfig, tmp_path: Path) -> None:
    room, agent, _, _ = make(config, tmp_path)
    hear(agent, ZACH, "Atlas, read launch.md from plans")
    await agent.idle()
    assert "No source called 'plans'" in room.sent[-1]
    assert "Friday" not in "".join(room.sent)


async def test_a_guest_reads_a_public_source(config: AgentConfig, tmp_path: Path) -> None:
    room, agent, _, _ = make(config, tmp_path)
    hear(agent, ZACH, "Atlas, read readme.md from site")
    await agent.idle()
    assert "mooz is a meeting app." in room.sent[-1]


async def test_only_the_owner_can_write_memory(config: AgentConfig, tmp_path: Path) -> None:
    room, agent, _, memory = make(config, tmp_path)
    hear(agent, ZACH, "Atlas, remember that Zach owns the budget")
    await agent.idle()
    assert "Only Kainoa can change my memory" in room.sent[-1]
    assert memory.all(owner=True) == []

    hear(agent, KAI, "Atlas, remember that the demo is on Thursday")
    await agent.idle()
    [note] = memory.all(owner=True)
    assert note.text == "the demo is on Thursday" and not note.public


async def test_private_memories_stay_with_the_owner(config: AgentConfig, tmp_path: Path) -> None:
    room, agent, _, memory = make(config, tmp_path)
    memory.remember("the demo is on Thursday", public=False)
    memory.remember("our office is in Honolulu", public=True)

    hear(agent, ZACH, "Atlas, what do you remember?")
    await agent.idle()
    assert "Honolulu" in room.sent[-1] and "Thursday" not in room.sent[-1]

    hear(agent, KAI, "Atlas, what do you remember?")
    await agent.idle()
    assert "Honolulu" in room.sent[-1] and "Thursday" in room.sent[-1]


async def test_says_a_short_filler_while_tools_run(config: AgentConfig, tmp_path: Path) -> None:
    room, agent, tts, _ = make(config, tmp_path)
    hear(agent, KAI, "Atlas, read launch.md from plans")
    await agent.idle()
    assert tts.spoken[0] == FILLER.spoken
    assert all(FILLER.spoken not in sent for sent in room.sent)  # voice only, not chat
    assert len(room.sent) == 1


async def test_plain_questions_need_no_tools_or_filler(config: AgentConfig, tmp_path: Path) -> None:
    room, agent, tts, _ = make(config, tmp_path)
    hear(agent, ZACH, "Atlas, what is 2+2?")
    await agent.idle()
    assert room.sent == ["You asked: what is 2+2?"]
    assert tts.spoken == ["You asked: what is 2+2?"]


async def test_lists_what_it_can_read_for_each_person(config: AgentConfig, tmp_path: Path) -> None:
    room, agent, _, _ = make(config, tmp_path)
    hear(agent, ZACH, "Atlas, what can you read?")
    await agent.idle()
    assert "site" in room.sent[-1] and "plans" not in room.sent[-1]
    hear(agent, KAI, "Atlas, what can you read?")
    await agent.idle()
    assert "site" in room.sent[-1] and "plans" in room.sent[-1]


def test_agent_owner_comes_from_the_room() -> None:
    assert ME.owner_identity == KAI.identity
