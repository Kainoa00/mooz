"""Claude as the agent's brain, called with the agent owner's own Anthropic API key."""

from __future__ import annotations

import json
import logging
from typing import Any, Literal

import anthropic

from ..room import Speaker
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

ANSWER_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "spoken": {
            "type": "string",
            "description": "What you say out loud: one to three short sentences of plain speech.",
        },
        "details": {
            "type": "string",
            "description": (
                "Optional extra for the meeting chat (markdown, code, links). Empty if none."
            ),
        },
    },
    "required": ["spoken", "details"],
    "additionalProperties": False,
}

DECLINE = Answer("Sorry, I can't help with that one.")


def _system_prompt(agent_name: str, owner_name: str) -> str:
    rules = [
        'Your "spoken" reply is read aloud by a voice. Keep it to one to three short sentences '
        "(about 40 words at most) of natural speech. No markdown, lists, code, URLs, or file "
        "paths in it.",
        "Put anything that only works in writing (code, commands, links, longer explanations) "
        'in "details"; it goes to the meeting chat. Leave "details" empty when the spoken reply '
        "is enough.",
        "If you don't know or the question is unclear, say so briefly or ask one short "
        "clarifying question.",
        "You are an AI agent. Never claim or imply that you are a person.",
        "You only know what was said in this meeting (the transcript you are given) and general "
        "knowledge. You cannot read files, repositories, or accounts yet; if asked to, say that "
        "isn't connected yet.",
        "Several people may be in the meeting; address the person who asked by name when it helps.",
    ]
    intro = (
        f"You are {agent_name}, the personal AI agent of {owner_name}, taking part in a live "
        "video meeting. People talk to you by saying your name. Everyone in the meeting hears "
        "what you say."
    )
    return intro + "\n\nHow to answer:\n" + "\n".join(f"- {r}" for r in rules)


def _asker_label(asker: Speaker, owner_identity: str | None) -> str:
    if owner_identity and asker.identity == owner_identity:
        return f"{asker.name} (your owner)"
    if owner_identity:
        return f"{asker.name} (not your owner)"
    return asker.name


class ClaudeBrain:
    def __init__(
        self,
        *,
        agent_name: str,
        owner_name: str,
        owner_identity: str | None = None,
        client: anthropic.AsyncAnthropic | None = None,
        model: str = DEFAULT_MODEL,
        effort: Effort = DEFAULT_EFFORT,
    ) -> None:
        # A spoken answer that arrives minutes late is worse than an apology.
        self._client = client or anthropic.AsyncAnthropic(timeout=30.0, max_retries=1)
        self._model = model
        self._effort = effort
        self._owner_identity = owner_identity
        self._system = _system_prompt(agent_name, owner_name)

    async def answer(self, *, question: str, asker: Speaker, transcript: str) -> Answer:
        who = _asker_label(asker, self._owner_identity)
        user = (
            "Recent meeting transcript (oldest first):\n"
            f"<transcript>\n{transcript}\n</transcript>\n\n"
            f"{who} just asked you: "
            f"{question or '(they said your name; respond briefly)'}"
        )
        try:
            response: Any = await self._client.beta.messages.create(
                model=self._model,
                max_tokens=MAX_TOKENS,
                system=self._system,
                messages=[{"role": "user", "content": user}],
                output_config={
                    "effort": self._effort,
                    "format": {"type": "json_schema", "schema": ANSWER_SCHEMA},
                },
                betas=[FALLBACK_BETA],
                fallbacks="default",
            )
        except anthropic.APIStatusError as err:
            log.error("Claude returned %s: %s", err.status_code, err.message)
            raise BrainError(f"Claude returned {err.status_code}") from err
        except anthropic.APIConnectionError as err:
            log.error("could not reach Claude: %s", err)
            raise BrainError("could not reach Claude") from err

        if response.stop_reason == "refusal":
            return DECLINE
        # Never read raw or truncated model output aloud.
        if response.stop_reason == "max_tokens":
            raise BrainError("Claude's answer was cut off")
        text = "".join(b.text for b in response.content if b.type == "text").strip()
        try:
            data = json.loads(text)
            spoken = str(data["spoken"]).strip()
        except (ValueError, KeyError, TypeError) as err:
            raise BrainError("Claude returned an answer in an unexpected format") from err
        return Answer(spoken, str(data.get("details", "")).strip()) if spoken else DECLINE
