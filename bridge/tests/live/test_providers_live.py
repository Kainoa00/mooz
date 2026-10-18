"""Real API calls. Run with MOOZ_LIVE_TESTS=1 and keys in the environment (costs money)."""

import os
from pathlib import Path

import aiohttp
import pytest

from mooz_agent.brain import ToolLoopBrain
from mooz_agent.providers.base import Answer
from mooz_agent.providers.claude import ClaudeModel
from mooz_agent.providers.elevenlabs import ElevenLabsTTS
from mooz_agent.room import Speaker

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(os.environ.get("MOOZ_LIVE_TESTS") != "1", reason="set MOOZ_LIVE_TESTS=1"),
]


@pytest.mark.skipif(not os.environ.get("ANTHROPIC_API_KEY"), reason="needs ANTHROPIC_API_KEY")
async def test_claude_answers_briefly_from_the_transcript() -> None:
    brain = ToolLoopBrain(
        model=ClaudeModel(), agent_name="Atlas", owner_name="Kainoa", owner_identity="p_k"
    )

    answer = await brain.answer(
        question="what did Zach say is blocking the deploy?",
        asker=Speaker("p_k", "Kainoa", "human"),
        transcript="Zach: the deploy is blocked on the database migration\nKainoa: ugh",
    )

    assert isinstance(answer, Answer)
    assert "migration" in answer.spoken.lower()
    assert len(answer.spoken.split()) <= 60


@pytest.mark.skipif(not os.environ.get("ELEVEN_API_KEY"), reason="needs ELEVEN_API_KEY")
async def test_elevenlabs_speaks_48k_frames() -> None:
    async with aiohttp.ClientSession() as http:
        tts = ElevenLabsTTS(
            api_key=os.environ["ELEVEN_API_KEY"],
            voice_id=os.environ.get("MOOZ_VOICE_ID"),
            http=http,
        )
        frames = [f async for f in tts.synthesize("Hello from mooz.")]

    assert frames
    assert {f.sample_rate for f in frames} == {48_000}


@pytest.mark.skipif(not os.environ.get("XAI_API_KEY"), reason="needs XAI_API_KEY")
async def test_grok_answers_briefly_from_the_transcript() -> None:
    from mooz_agent.providers.grok import GrokModel

    brain = ToolLoopBrain(
        model=GrokModel(), agent_name="Atlas", owner_name="Kainoa", owner_identity="p_k"
    )

    answer = await brain.answer(
        question="what did Zach say is blocking the deploy?",
        asker=Speaker("p_k", "Kainoa", "human"),
        transcript="Zach: the deploy is blocked on the database migration",
    )

    assert "migration" in answer.spoken.lower()


def _models() -> list[tuple[str, object]]:
    from mooz_agent.providers.grok import GrokModel

    models: list[tuple[str, object]] = []
    if os.environ.get("ANTHROPIC_API_KEY"):
        models.append(("claude", ClaudeModel()))
    if os.environ.get("XAI_API_KEY"):
        models.append(("grok", GrokModel()))
    return models


def _brain(model: object, tmp_path: Path, *, web_search: bool) -> ToolLoopBrain:
    from mooz_agent.config import AgentConfig
    from mooz_agent.memory import MemoryStore
    from mooz_agent.tools.toolbox import ToolBox

    (tmp_path / "plans").mkdir()
    (tmp_path / "plans" / "launch.md").write_text("# Launch\nWe launch the beta on March 30th.\n")
    config = AgentConfig(name="Atlas")
    config.add_source(tmp_path / "plans", label="plans")
    memory = MemoryStore(tmp_path / "memory.jsonl")
    return ToolLoopBrain(
        model=model,  # type: ignore[arg-type]
        agent_name="Atlas",
        owner_name="Kainoa",
        owner_identity="p_k",
        toolbox=ToolBox(config, memory, owner_name="Kainoa"),
        memory=memory,
        web_search=web_search,
    )


@pytest.mark.parametrize(
    ("name", "model"),
    _models()
    or [
        pytest.param(
            "none", None, marks=pytest.mark.skip(reason="needs ANTHROPIC_API_KEY or XAI_API_KEY")
        )
    ],
)
async def test_quick_answers_use_the_owners_files(name: str, model: object, tmp_path: Path) -> None:
    brain = _brain(model, tmp_path, web_search=False)
    answer = await brain.answer(
        question="when do we launch the beta? check the plans folder",
        asker=Speaker("p_k", "Kainoa", "human"),
        transcript="",
    )
    assert "30" in answer.spoken, f"{name}: {answer}"


@pytest.mark.parametrize(
    ("name", "model"),
    _models()
    or [
        pytest.param(
            "none", None, marks=pytest.mark.skip(reason="needs ANTHROPIC_API_KEY or XAI_API_KEY")
        )
    ],
)
async def test_research_reads_files_searches_the_web_and_reports(
    name: str, model: object, tmp_path: Path
) -> None:
    brain = _brain(model, tmp_path, web_search=True)
    progress: list[str] = []
    answer = await brain.research(
        title="Look into our beta launch date in the plans folder, and search the web for "
        "the year the LiveKit project was first released",
        progress=progress.append,
    )
    assert "30" in f"{answer.spoken} {answer.details}", f"{name}: {answer}"
    assert any(p.startswith("Reading launch.md") or p.startswith("Searching") for p in progress)
    assert any(p.startswith("Searched the web") for p in progress), f"{name}: {progress}"
    assert len(answer.spoken.split()) <= 60
