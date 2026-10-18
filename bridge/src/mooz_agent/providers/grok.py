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

from ..brain import ANSWER_SCHEMA, Mode, ModelTurn, ToolCall
from ..tools.toolbox import ToolResult, ToolSpec
from .base import MAX_WEB_SEARCHES, Answer, BrainError, plain_answer

log = logging.getLogger(__name__)

XAI_BASE_URL = "https://api.x.ai/v1"
DEFAULT_GROK_MODEL = "grok-4.7"
MAX_OUTPUT_TOKENS = 8000
RESEARCH_MAX_OUTPUT_TOKENS = 16_000
RESEARCH_TIMEOUT = 180.0
WEB_SEARCH_TOOL = {"type": "web_search"}


def _strict_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """OpenAI-style strict mode: every property is required, so optional ones become nullable."""
    required = list(schema.get("required", []))
    properties: dict[str, Any] = {}
    for name, prop in schema.get("properties", {}).items():
        if name in required:
            properties[name] = prop
            continue
        nullable = {**prop, "type": [prop["type"], "null"]}
        if "enum" in prop:
            nullable["enum"] = [*prop["enum"], None]
        properties[name] = nullable
    return {
        **schema,
        "properties": properties,
        "required": [*required, *(n for n in properties if n not in required)],
    }


def _tool_param(spec: ToolSpec) -> dict[str, Any]:
    return {
        "type": "function",
        "name": spec.name,
        "description": spec.description,
        "parameters": _strict_schema(spec.parameters),
        "strict": True,
    }


def _searches(output: Sequence[Any]) -> list[str]:
    """Queries from xAI's own web search steps (shown as task progress)."""
    queries = []
    for item in output:
        if item.type != "web_search_call":
            continue
        query = getattr(getattr(item, "action", None), "query", None)
        if isinstance(query, str) and query.strip():
            queries.append(query.strip())
    return queries


def _args(raw: str) -> dict[str, object]:
    try:
        value = json.loads(raw or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


class GrokConversation:
    def __init__(
        self,
        client: Any,
        *,
        model: str,
        system: str,
        tools: Sequence[ToolSpec],
        mode: Mode = "answer",
        web_search: bool = False,
    ) -> None:
        self._client = client
        self._model = model
        self._system = system
        self._mode = mode
        self._tools = [_tool_param(t) for t in tools]
        self._web_search = mode == "research" and web_search
        # xAI has no per-request search cap: stop offering it once the task's budget is spent.
        self._searches_left = MAX_WEB_SEARCHES
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

    def _kwargs(self, items: list[dict[str, Any]]) -> dict[str, Any]:
        research = self._mode == "research"
        kwargs: dict[str, Any] = {
            "model": self._model,
            "instructions": self._system,  # not carried over by previous_response_id
            "input": items,
            "max_output_tokens": RESEARCH_MAX_OUTPUT_TOKENS if research else MAX_OUTPUT_TOKENS,
        }
        if research:
            # Research ends with the report_findings tool, not a JSON answer format.
            kwargs["timeout"] = RESEARCH_TIMEOUT
        else:
            kwargs["text"] = {
                "format": {
                    "type": "json_schema",
                    "name": "meeting_answer",
                    "schema": ANSWER_SCHEMA,
                    "strict": True,
                }
            }
        tools = [*self._tools, *([dict(WEB_SEARCH_TOOL)] if self._web_search else [])]
        if tools:
            kwargs["tools"] = tools
        if self._last_id:
            kwargs["previous_response_id"] = self._last_id
        return kwargs

    async def _call(self, items: list[dict[str, Any]]) -> ModelTurn:
        try:
            try:
                response: Any = await self._client.responses.create(**self._kwargs(items))
            except openai.BadRequestError as err:
                if not self._web_search:
                    raise
                # xAI doesn't document web search alongside function tools: if it refuses
                # the combination, carry on without web search for the rest of the task.
                log.warning("Grok refused web search with our tools (%s); continuing without", err)
                self._web_search = False
                response = await self._client.responses.create(**self._kwargs(items))
        except openai.APIStatusError as err:
            log.error("Grok returned %s: %s", err.status_code, err.message)
            raise BrainError(f"Grok returned {err.status_code}") from err
        except openai.APIConnectionError as err:
            log.error("could not reach Grok: %s", err)
            raise BrainError("could not reach Grok") from err

        self._last_id = response.id
        self._searches_left -= sum(1 for item in response.output if item.type == "web_search_call")
        if self._searches_left <= 0:
            self._web_search = False
        if response.status == "incomplete":
            raise BrainError("Grok's answer was cut off")
        searches = tuple(_searches(response.output))
        calls = tuple(
            ToolCall(id=item.call_id, name=item.name, args=_args(item.arguments))
            for item in response.output
            if item.type == "function_call"
        )
        if calls:
            return ModelTurn(calls=calls, searches=searches)
        parts = [c for item in response.output if item.type == "message" for c in item.content]
        if any(c.type == "refusal" for c in parts):
            return ModelTurn(refused=True)
        text = "".join(c.text for c in parts if c.type == "output_text").strip()
        if self._mode == "research":
            return ModelTurn(answer=plain_answer(text), searches=searches)
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

    def conversation(
        self,
        *,
        system: str,
        tools: Sequence[ToolSpec],
        mode: Mode = "answer",
        web_search: bool = False,
    ) -> GrokConversation:
        return GrokConversation(
            self._client,
            model=self._model,
            system=system,
            tools=tools,
            mode=mode,
            web_search=web_search,
        )
