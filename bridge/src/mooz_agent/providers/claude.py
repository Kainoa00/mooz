"""Claude as the agent's brain, called with the agent owner's own Anthropic API key."""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from typing import Any, Literal

import anthropic

from ..brain import ANSWER_SCHEMA, Mode, ModelTurn, ToolCall
from ..tools.toolbox import ToolResult, ToolSpec
from .base import Answer, BrainError, plain_answer

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

# Background research: deeper thinking, room to work, and Claude's own web search.
RESEARCH_EFFORT: Effort = "high"
RESEARCH_MAX_TOKENS = 16_000
RESEARCH_TIMEOUT = 180.0
WEB_SEARCH_TOOL = {"type": "web_search_20260209", "name": "web_search", "max_uses": 5}
# A long server-side search can pause the turn; resume it at most this many times.
MAX_PAUSES = 5


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
        mode: Mode = "answer",
        web_search: bool = False,
    ) -> None:
        self._client = client
        self._model = model
        self._mode = mode
        self._effort = RESEARCH_EFFORT if mode == "research" else effort
        self._system = system
        self._tools: list[dict[str, Any]] = [_tool_param(t) for t in tools]
        if mode == "research" and web_search:
            self._tools.append(dict(WEB_SEARCH_TOOL))
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

    async def _request(self) -> Any:
        research = self._mode == "research"
        output_config: dict[str, Any] = {"effort": self._effort}
        if not research:
            # Research ends with the report_findings tool instead (web search's citations
            # and a JSON answer format don't mix).
            output_config["format"] = {"type": "json_schema", "schema": ANSWER_SCHEMA}
        kwargs: dict[str, Any] = {
            "model": self._model,
            "max_tokens": RESEARCH_MAX_TOKENS if research else MAX_TOKENS,
            "system": self._system,
            "messages": self._messages,
            "output_config": output_config,
            "betas": [FALLBACK_BETA],
            "fallbacks": "default",
        }
        if self._tools:
            kwargs["tools"] = self._tools
        if research:
            kwargs["timeout"] = RESEARCH_TIMEOUT
        try:
            response = await self._client.beta.messages.create(**kwargs)
        except anthropic.APIStatusError as err:
            log.error("Claude returned %s: %s", err.status_code, err.message)
            raise BrainError(f"Claude returned {err.status_code}") from err
        except anthropic.APIConnectionError as err:
            log.error("could not reach Claude: %s", err)
            raise BrainError("could not reach Claude") from err
        # Pass the whole content back unchanged (thinking blocks included) on the next turn.
        self._messages.append({"role": "assistant", "content": response.content})
        return response

    async def _call(self) -> ModelTurn:
        searches: list[str] = []
        response = await self._request()
        for _ in range(MAX_PAUSES):
            searches += _searches(response.content)
            if response.stop_reason != "pause_turn":
                break
            # A long server-side search paused: resend as is and it carries on.
            response = await self._request()
        else:
            raise BrainError("Claude kept pausing its web search")
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
            return ModelTurn(calls=calls, searches=tuple(searches))
        if self._mode == "research":
            return ModelTurn(answer=_plain_answer(response.content), searches=tuple(searches))
        return ModelTurn(answer=_parse_answer(response.content))


def _searches(content: Sequence[Any]) -> list[str]:
    queries = []
    for block in content:
        if block.type == "server_tool_use" and block.name == "web_search":
            query = (block.input or {}).get("query")
            if isinstance(query, str) and query.strip():
                queries.append(query.strip())
    return queries


def _plain_answer(content: Sequence[Any]) -> Answer:
    return plain_answer("".join(b.text for b in content if b.type == "text"))


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

    def conversation(
        self,
        *,
        system: str,
        tools: Sequence[ToolSpec],
        mode: Mode = "answer",
        web_search: bool = False,
    ) -> ClaudeConversation:
        return ClaudeConversation(
            self._client,
            model=self._model,
            effort=self._effort,
            system=system,
            tools=tools,
            mode=mode,
            web_search=web_search,
        )
