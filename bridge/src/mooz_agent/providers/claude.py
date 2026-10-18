"""Claude as the agent's brain, called with the agent owner's own Anthropic API key."""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from typing import Any, Literal

import anthropic

from ..brain import ANSWER_SCHEMA, ModelTurn, ToolCall
from ..tools.toolbox import ToolResult, ToolSpec
from .base import Answer, BrainError

log = logging.getLogger(__name__)

DEFAULT_MODEL = "claude-opus-5-5"
# Spoken replies must start fast; low effort keeps thinking short for meeting Q&A.
Effort = Literal["low", "medium", "high", "xhigh", "max"]
DEFAULT_EFFORT: Effort = "low"
# Thinking tokens count toward this, so it is generous even though replies are short.
MAX_TOKENS = 8000
# Opt in to server-side fallback: if a request is declined by a safety classifier,
# the API retries it on a fallback model chosen per refusal category.
FALLBACK_BETA = "server-side-fallback-2026-07-01"


def _tool_param(spec: ToolSpec) -> dict[str, Any]:
    return {
        "name": spec.name,
        "description": spec.description,
        "input_schema": spec.parameters,
        "strict": True,
    }


class ClaudeConversation:
    def __init__(
        self,
        client: Any,
        *,
        model: str,
        effort: Effort,
        system: str,
        tools: Sequence[ToolSpec],
    ) -> None:
        self._client = client
        self._model = model
        self._effort = effort
        self._system = system
        self._tools = [_tool_param(t) for t in tools]
        self._messages: list[dict[str, Any]] = []

    async def send(self, user: str) -> ModelTurn:
        self._messages.append({"role": "user", "content": user})
        return await self._call()

    async def send_results(self, results: Sequence[tuple[ToolCall, ToolResult]]) -> ModelTurn:
        self._messages.append(
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": call.id,
                        "content": result.content,
                        "is_error": result.is_error,
                    }
                    for call, result in results
                ],
            }
        )
        return await self._call()

    async def _call(self) -> ModelTurn:
        kwargs: dict[str, Any] = {
            "model": self._model,
            "max_tokens": MAX_TOKENS,
            "system": self._system,
            "messages": self._messages,
            "output_config": {
                "effort": self._effort,
                "format": {"type": "json_schema", "schema": ANSWER_SCHEMA},
            },
            "betas": [FALLBACK_BETA],
            "fallbacks": "default",
        }
        if self._tools:
            kwargs["tools"] = self._tools
        try:
            response: Any = await self._client.beta.messages.create(**kwargs)
        except anthropic.APIStatusError as err:
            log.error("Claude returned %s: %s", err.status_code, err.message)
            raise BrainError(f"Claude returned {err.status_code}") from err
        except anthropic.APIConnectionError as err:
            log.error("could not reach Claude: %s", err)
            raise BrainError("could not reach Claude") from err

        # Pass the whole content back unchanged (thinking blocks included) on the next turn.
        self._messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason == "refusal":
            return ModelTurn(refused=True)
        if response.stop_reason == "max_tokens":
            raise BrainError("Claude's answer was cut off")
        calls = tuple(
            ToolCall(id=b.id, name=b.name, args=dict(b.input))
            for b in response.content
            if b.type == "tool_use"
        )
        if calls:
            return ModelTurn(calls=calls)
        return ModelTurn(answer=_parse_answer(response.content))


def _parse_answer(content: Sequence[Any]) -> Answer:
    text = "".join(b.text for b in content if b.type == "text").strip()
    try:
        data = json.loads(text)
        return Answer(str(data["spoken"]).strip(), str(data.get("details", "")).strip())
    except (ValueError, KeyError, TypeError) as err:
        # Never read raw model output aloud.
        raise BrainError("Claude returned an answer in an unexpected format") from err


class ClaudeModel:
    def __init__(
        self,
        *,
        client: Any | None = None,
        model: str = DEFAULT_MODEL,
        effort: Effort = DEFAULT_EFFORT,
    ) -> None:
        # A spoken answer that arrives minutes late is worse than an apology.
        self._client = client or anthropic.AsyncAnthropic(timeout=30.0, max_retries=1)
        self._model = model
        self._effort = effort

    def conversation(self, *, system: str, tools: Sequence[ToolSpec]) -> ClaudeConversation:
        return ClaudeConversation(
            self._client, model=self._model, effort=self._effort, system=system, tools=tools
        )
