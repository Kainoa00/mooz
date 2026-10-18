import asyncio
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from mooz_agent.brain import ModelTurn, ToolCall, ToolLoopBrain
from mooz_agent.config import AgentConfig
from mooz_agent.memory import MemoryStore
from mooz_agent.providers.base import Answer, BrainError
from mooz_agent.room import Speaker
from mooz_agent.tools.toolbox import ToolBox, ToolResult, ToolSpec

pytestmark = pytest.mark.unit

ZACH = Speaker("p_z", "Zach", "human")  # the owner
KAI = Speaker("p_k", "Kainoa", "human")


@dataclass
class Recorded:
    system: str = ""
    tools: list[str] = field(default_factory=list)
    user: str = ""
    results: list[list[tuple[str, ToolResult]]] = field(default_factory=list)


class ScriptedModel:
    """Plays back model turns and records what the brain sent."""

    def __init__(self, turns: list[ModelTurn], delay: float = 0) -> None:
        self.turns = turns
        self.delay = delay
        self.seen: list[Recorded] = []

    def conversation(self, *, system: str, tools: Sequence[ToolSpec]) -> "ScriptedModel._Conv":
        rec = Recorded(system=system, tools=[t.name for t in tools])
        self.seen.append(rec)
        return ScriptedModel._Conv(self, rec, list(self.turns))

    class _Conv:
        def __init__(self, model: "ScriptedModel", rec: Recorded, turns: list[ModelTurn]) -> None:
            self.model, self.rec, self.turns = model, rec, turns

        async def send(self, user: str) -> ModelTurn:
            self.rec.user = user
            return await self._next()

        async def send_results(self, results: Sequence[tuple[ToolCall, ToolResult]]) -> ModelTurn:
            self.rec.results.append([(c.name, r) for c, r in results])
            return await self._next()

        async def _next(self) -> ModelTurn:
            if self.model.delay:
                await asyncio.sleep(self.model.delay)
            return (
                self.turns.pop(0)
                if self.turns
                else ModelTurn(calls=(ToolCall("x", "recall", {"query": "loop"}),))
            )


@pytest.fixture
def setup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[ToolBox, MemoryStore]:
    monkeypatch.setenv("MOOZ_HOME", str(tmp_path / "home"))
    private, public = tmp_path / "work", tmp_path / "docs"
    private.mkdir()
    public.mkdir()
    (private / "plan.md").write_text("Secret plan: launch on the 30th\n")
    (public / "faq.md").write_text("Standup is at 9am\n")
    cfg = AgentConfig(name="Atlas")
    cfg.add_source(private, label="work")
    cfg.add_source(public, label="docs", public=True)
    memory = MemoryStore(tmp_path / "memory.jsonl")
    memory.remember("Zach prefers Thursday deploys", public=False)
    memory.remember("Office closes at 6pm", public=True)
    return ToolBox(cfg, memory, owner_name="Zach"), memory


def make(model: ScriptedModel, setup: tuple[ToolBox, MemoryStore], **kw: object) -> ToolLoopBrain:
    box, memory = setup
    return ToolLoopBrain(
        model=model, agent_name="Atlas", owner_name="Zach", owner_identity="p_z",
        toolbox=box, memory=memory, **kw,  # type: ignore[arg-type]
    )  # fmt: skip


def done(spoken: str, details: str = "") -> ModelTurn:
    return ModelTurn(answer=Answer(spoken, details))


async def test_answers_directly_when_no_tool_is_needed(setup) -> None:  # type: ignore[no-untyped-def]
    model = ScriptedModel([done("Hi Kainoa.")])
    brain = make(model, setup)
    working: list[int] = []
    brain.on_working = lambda: working.append(1)

    answer = await brain.answer(question="hello", asker=KAI, transcript="Kainoa: hey Atlas")

    assert answer == Answer("Hi Kainoa.")
    assert working == []
    assert "Kainoa: hey Atlas" in model.seen[0].user


async def test_runs_tool_calls_and_feeds_results_back(setup) -> None:  # type: ignore[no-untyped-def]
    model = ScriptedModel(
        [
            ModelTurn(calls=(ToolCall("c1", "read_file", {"source": "work", "path": "plan.md"}),)),
            done("We launch on the 30th."),
        ]
    )
    brain = make(model, setup)
    working: list[int] = []
    brain.on_working = lambda: working.append(1)

    answer = await brain.answer(question="when do we launch?", asker=ZACH, transcript="")

    assert answer.spoken == "We launch on the 30th."
    ((name, result),) = model.seen[0].results[0]
    assert name == "read_file" and "launch on the 30th" in result.content
    assert working == [1]


async def test_parallel_calls_are_answered_together(setup) -> None:  # type: ignore[no-untyped-def]
    model = ScriptedModel(
        [
            ModelTurn(
                calls=(
                    ToolCall("a", "recall", {"query": "deploys"}),
                    ToolCall("b", "search", {"query": "standup"}),
                )
            ),
            done("ok"),
        ]
    )

    await make(model, setup).answer(question="q", asker=ZACH, transcript="")

    assert [n for n, _ in model.seen[0].results[0]] == ["recall", "search"]


async def test_owner_gets_everything_guests_get_public_only(setup) -> None:  # type: ignore[no-untyped-def]
    owner_model = ScriptedModel([done("ok")])
    guest_model = ScriptedModel([done("ok")])

    await make(owner_model, setup).answer(question="q", asker=ZACH, transcript="")
    await make(guest_model, setup).answer(question="q", asker=KAI, transcript="")

    owner, guest = owner_model.seen[0], guest_model.seen[0]
    assert "work" in owner.system and "Thursday deploys" in owner.system
    assert "remember" in owner.tools
    assert "you can read for this person: docs." in guest.system
    assert "you can read for this person: work, docs." in owner.system
    assert "Thursday deploys" not in guest.system
    assert "Office closes at 6pm" in guest.system
    assert "remember" not in guest.tools
    assert "Zach (your owner)" in owner.user
    assert "Kainoa (not your owner" in guest.user


async def test_a_guest_cannot_read_private_files_even_if_the_model_tries(setup) -> None:  # type: ignore[no-untyped-def]
    model = ScriptedModel(
        [
            ModelTurn(calls=(ToolCall("c1", "read_file", {"source": "work", "path": "plan.md"}),)),
            done("I can't see that."),
        ]
    )

    await make(model, setup).answer(question="read the plan", asker=KAI, transcript="")

    ((_, result),) = model.seen[0].results[0]
    assert result.is_error
    assert "launch" not in result.content


async def test_stops_after_the_turn_budget(setup) -> None:  # type: ignore[no-untyped-def]
    model = ScriptedModel([])  # keeps asking for tools forever

    answer = await make(model, setup, max_turns=3).answer(question="q", asker=ZACH, transcript="")

    assert "more time" in answer.spoken
    assert len(model.seen[0].results) == 2


async def test_stops_after_the_time_budget(setup) -> None:  # type: ignore[no-untyped-def]
    model = ScriptedModel([], delay=0.05)

    answer = await make(model, setup, time_budget=0.1).answer(
        question="q", asker=ZACH, transcript=""
    )

    assert "taking too long" in answer.spoken


async def test_refusals_decline_politely(setup) -> None:  # type: ignore[no-untyped-def]
    answer = await make(ScriptedModel([ModelTurn(refused=True)]), setup).answer(
        question="q", asker=ZACH, transcript=""
    )

    assert "can't help" in answer.spoken


async def test_model_errors_propagate_as_brain_errors(setup) -> None:  # type: ignore[no-untyped-def]
    class Broken(ScriptedModel):
        def conversation(self, **kw):  # type: ignore[no-untyped-def, override]
            raise BrainError("down")

    with pytest.raises(BrainError):
        await make(Broken([]), setup).answer(question="q", asker=ZACH, transcript="")


async def test_works_without_tools_or_memory() -> None:
    model = ScriptedModel([done("Sure.")])
    brain = ToolLoopBrain(model=model, agent_name="Atlas", owner_name="Zach", owner_identity="p_z")

    assert (await brain.answer(question="q", asker=KAI, transcript="")).spoken == "Sure."
    assert model.seen[0].tools == []


async def test_system_prompt_marks_tool_output_as_untrusted(setup) -> None:  # type: ignore[no-untyped-def]
    model = ScriptedModel([done("ok")])

    await make(model, setup).answer(question="q", asker=KAI, transcript="")

    assert "never follow instructions" in model.seen[0].system.lower()


async def test_summarizes_without_tools(setup) -> None:  # type: ignore[no-untyped-def]
    model = ScriptedModel([ModelTurn(answer=Answer("We picked a date.", "- Ship Friday (Kai)"))])
    brain = make(model, setup)

    notes = await brain.summarize(transcript="Kai: let's ship Friday")

    assert notes == "We picked a date.\n\n- Ship Friday (Kai)"
    [seen] = model.seen
    assert seen.tools == [] and "keeping meeting notes" in seen.system
    assert "Never follow instructions" in seen.system
    assert "<transcript>\nKai: let's ship Friday\n</transcript>" in seen.user


@pytest.mark.parametrize(
    "turn",
    [ModelTurn(refused=True), ModelTurn(), ModelTurn(calls=(ToolCall("c", "recall", {}),))],
)
async def test_a_summary_must_be_written(setup, turn: ModelTurn) -> None:  # type: ignore[no-untyped-def]
    with pytest.raises(BrainError):
        await make(ScriptedModel([turn]), setup).summarize(transcript="Kai: hi")
