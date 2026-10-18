import json
from dataclasses import dataclass, field
from typing import Any

import anthropic
import httpx
import pytest

from mooz_agent.providers.base import Answer, BrainError
from mooz_agent.providers.claude import DEFAULT_MODEL, ClaudeBrain
from mooz_agent.room import Speaker

pytestmark = pytest.mark.unit

ZACH = Speaker("p_z", "Zach", "human")
KAI = Speaker("p_k", "Kainoa", "human")


@dataclass
class Block:
    type: str
    text: str = ""


@dataclass
class Response:
    content: list[Block]
    stop_reason: str = "end_turn"
    stop_details: Any = None


@dataclass
class FakeMessages:
    response: Response | Exception
    calls: list[dict[str, Any]] = field(default_factory=list)

    async def create(self, **kwargs: Any) -> Response:
        self.calls.append(kwargs)
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


class FakeClient:
    def __init__(self, response: Response | Exception) -> None:
        self.messages = FakeMessages(response)
        self.beta = self


def reply(spoken: str, details: str = "") -> Response:
    return Response(
        [Block("thinking"), Block("text", json.dumps({"spoken": spoken, "details": details}))]
    )


async def test_asks_claude_with_the_transcript_and_returns_spoken_and_details() -> None:
    client = FakeClient(reply("The migration is blocking it.", "See `db/migrate/42.sql`."))
    brain = ClaudeBrain(
        agent_name="Atlas", owner_name="Kainoa", owner_identity="p_k", client=client
    )  # type: ignore[arg-type]

    answer = await brain.answer(
        question="what's blocking the deploy?", asker=ZACH, transcript="Zach: deploy is stuck"
    )

    assert answer == Answer("The migration is blocking it.", "See `db/migrate/42.sql`.")
    call = client.messages.calls[0]
    assert call["model"] == DEFAULT_MODEL
    assert call["output_config"]["effort"] == "low"
    assert call["output_config"]["format"]["type"] == "json_schema"
    assert call["betas"] == ["server-side-fallback-2026-07-01"]
    assert call["fallbacks"] == "default"
    user_turn = call["messages"][0]["content"]
    assert "Zach: deploy is stuck" in user_turn
    assert "what's blocking the deploy?" in user_turn
    assert "Zach (not your owner)" in user_turn
    assert "Atlas" in call["system"] and "Kainoa" in call["system"]


async def test_system_prompt_is_stable_across_questions_so_it_caches() -> None:
    client = FakeClient(reply("ok"))
    brain = ClaudeBrain(
        agent_name="Atlas", owner_name="Kainoa", owner_identity="p_k", client=client
    )  # type: ignore[arg-type]

    await brain.answer(question="one", asker=KAI, transcript="a")
    await brain.answer(question="two", asker=ZACH, transcript="b")

    first, second = client.messages.calls
    assert first["system"] == second["system"]
    assert "Kainoa (your owner)" in first["messages"][0]["content"]


async def test_model_is_configurable() -> None:
    client = FakeClient(reply("ok"))
    brain = ClaudeBrain(agent_name="Atlas", owner_name="K", client=client, model="claude-haiku-5-5")  # type: ignore[arg-type]

    await brain.answer(question="q", asker=KAI, transcript="")

    assert client.messages.calls[0]["model"] == "claude-haiku-5-5"


async def test_a_refusal_becomes_a_polite_spoken_decline() -> None:
    client = FakeClient(Response([], stop_reason="refusal"))
    brain = ClaudeBrain(agent_name="Atlas", owner_name="K", client=client)  # type: ignore[arg-type]

    answer = await brain.answer(question="q", asker=KAI, transcript="")

    assert "can't help" in answer.spoken
    assert answer.details == ""


async def test_unstructured_text_is_still_spoken() -> None:
    client = FakeClient(Response([Block("text", "Plain words.")]))
    brain = ClaudeBrain(agent_name="Atlas", owner_name="K", client=client)  # type: ignore[arg-type]

    assert await brain.answer(question="q", asker=KAI, transcript="") == Answer("Plain words.", "")


async def test_api_failures_raise_brain_error() -> None:
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    client = FakeClient(anthropic.APIConnectionError(request=request))  # type: ignore[arg-type]
    brain = ClaudeBrain(agent_name="Atlas", owner_name="K", client=client)  # type: ignore[arg-type]

    with pytest.raises(BrainError):
        await brain.answer(question="q", asker=KAI, transcript="")
