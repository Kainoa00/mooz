"""Grok as the agent's brain, through xAI's Responses API (owner's own XAI_API_KEY).

xAI documents the OpenAI SDK pointed at https://api.x.ai/v1 for function calling and
structured outputs. Turns are chained with previous_response_id, which means xAI stores the
conversation for the duration of the answer (see xAI's data retention terms).
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Sequence
from typing import Any

import openai

from ..brain import ANSWER_SCHEMA, ModelTurn, ToolCall
from ..tools.toolbox import ToolResult, ToolSpec
from .base import Answer, BrainError

log = logging.getLogger(__name__)

XAI_BASE_URL = "https://api.x.ai/v1"
DEFAULT_GROK_MODEL = "grok-4.7"
MAX_OUTPUT_TOKENS = 8000


def _tool_param(spec: ToolSpec) -> dict[str, Any]:
    return {
        "type": "function",
        "name": spec.name,
        "description": spec.description,
        "parameters": spec.parameters,
        "strict": True,
    }


def _args(raw: str) -> dict[str, object]:
    try:
        value = json.loads(raw or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


class GrokConversation:
    def __init__(self, client: Any, *, model: str, system: str, tools: Sequence[ToolSpec]) -> None:
        self._client = client
        self._model = model
        self._system = system
        self._tools = [_tool_param(t) for t in tools]
        self._last_id: str | None = None

    async def send(self, user: str) -> ModelTurn:
        return await self._call([{"role": "user", "content": user}])

    async def send_results(self, results: Sequence[tuple[ToolCall, ToolResult]]) -> ModelTurn:
        return await self._call(
            [
                {
                    "type": "function_call_output",
                    "call_id": call.id,
                    "output": f"Error: {result.content}" if result.is_error else result.content,
                }
                for call, result in results
            ]
        )

    async def _call(self, items: list[dict[str, Any]]) -> ModelTurn:
        kwargs: dict[str, Any] = {
            "model": self._model,
            "instructions": self._system,  # not carried over by previous_response_id
            "input": items,
            "max_output_tokens": MAX_OUTPUT_TOKENS,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "meeting_answer",
                    "schema": ANSWER_SCHEMA,
                    "strict": True,
                }
            },
        }
        if self._tools:
            kwargs["tools"] = self._tools
        if self._last_id:
            kwargs["previous_response_id"] = self._last_id
        try:
            response: Any = await self._client.responses.create(**kwargs)
        except openai.APIStatusError as err:
            log.error("Grok returned %s: %s", err.status_code, err.message)
            raise BrainError(f"Grok returned {err.status_code}") from err
        except openai.APIConnectionError as err:
            log.error("could not reach Grok: %s", err)
            raise BrainError("could not reach Grok") from err

        self._last_id = response.id
        if response.status == "incomplete":
            raise BrainError("Grok's answer was cut off")
        calls = tuple(
            ToolCall(id=item.call_id, name=item.name, args=_args(item.arguments))
            for item in response.output
            if item.type == "function_call"
        )
        if calls:
            return ModelTurn(calls=calls)
        parts = [c for item in response.output if item.type == "message" for c in item.content]
        if any(c.type == "refusal" for c in parts):
            return ModelTurn(refused=True)
        text = "".join(c.text for c in parts if c.type == "output_text").strip()
        try:
            data = json.loads(text)
            answer = Answer(str(data["spoken"]).strip(), str(data.get("details", "")).strip())
        except (ValueError, KeyError, TypeError) as err:
            raise BrainError("Grok returned an answer in an unexpected format") from err
        return ModelTurn(answer=answer)


class GrokModel:
    def __init__(self, *, client: Any | None = None, model: str = DEFAULT_GROK_MODEL) -> None:
        self._client = client or openai.AsyncOpenAI(
            base_url=XAI_BASE_URL,
            api_key=os.environ.get("XAI_API_KEY"),
            timeout=30.0,
            max_retries=1,
        )
        self._model = model

    def conversation(self, *, system: str, tools: Sequence[ToolSpec]) -> GrokConversation:
        return GrokConversation(self._client, model=self._model, system=system, tools=tools)
