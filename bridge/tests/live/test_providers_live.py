"""Real API calls. Run with MOOZ_LIVE_TESTS=1 and keys in the environment (costs money)."""

import os

import aiohttp
import pytest

from mooz_agent.providers.base import Answer
from mooz_agent.providers.claude import ClaudeBrain
from mooz_agent.providers.elevenlabs import ElevenLabsTTS
from mooz_agent.room import Speaker

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(os.environ.get("MOOZ_LIVE_TESTS") != "1", reason="set MOOZ_LIVE_TESTS=1"),
]


@pytest.mark.skipif(not os.environ.get("ANTHROPIC_API_KEY"), reason="needs ANTHROPIC_API_KEY")
async def test_claude_answers_briefly_from_the_transcript() -> None:
    brain = ClaudeBrain(agent_name="Atlas", owner_name="Kainoa", owner_identity="p_k")

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
