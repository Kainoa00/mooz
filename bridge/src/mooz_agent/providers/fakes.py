"""Deterministic stand-ins for the model and voice providers, for tests and offline demos."""

from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import TYPE_CHECKING, Any

from livekit import rtc

from ..room import Speaker
from .base import Answer

if TYPE_CHECKING:
    from ..brain import Mode, ModelTurn, ToolCall
    from ..tools.toolbox import ToolResult, ToolSpec


class FakeSTT:
    """Transcribes each speaker as a fixed script (or raises a scripted error)."""

    def __init__(
        self, scripts: Mapping[str, Sequence[str] | BaseException], delay: float = 0
    ) -> None:
        self._scripts = scripts
        self._delay = delay

    async def transcribe(self, speaker: Speaker, frames: AsyncIterator[Any]) -> AsyncIterator[str]:
        script = self._scripts.get(speaker.identity, [])
        if isinstance(script, BaseException):
            raise script
        lines = iter(script)
        async for _frame in frames:
            if self._delay:
                await asyncio.sleep(self._delay)
            line = next(lines, None)
            if line is None:
                continue
            yield line
        for line in lines:
            yield line


class FakeTTS:
    """Emits one 10 ms silent frame per word, and records what it was asked to say."""

    def __init__(self) -> None:
        self.spoken: list[str] = []

    async def synthesize(self, text: str) -> AsyncIterator[rtc.AudioFrame]:
        self.spoken.append(text)
        for _word in text.split():
            yield rtc.AudioFrame.create(48_000, 1, 480)
            await asyncio.sleep(0)


class EchoBrain:
    """Repeats the question back. Used for offline demos and end-to-end tests."""

    def __init__(self) -> None:
        self.questions: list[tuple[str, Speaker, str]] = []

    async def answer(self, *, question: str, asker: Speaker, transcript: str) -> Answer:
        self.questions.append((question, asker, transcript))
        return Answer(f"You asked: {question}")


class FakeBrain:
    """Answers from a fixed reply, recording every question it was asked."""

    def __init__(self, reply: str = "Fake answer.", details: str = "") -> None:
        self.reply = Answer(reply, details)
        self.questions: list[tuple[str, Speaker, str]] = []

    async def answer(self, *, question: str, asker: Speaker, transcript: str) -> Answer:
        self.questions.append((question, asker, transcript))
        return self.reply


# -- the offline model ---------------------------------------------------------------

ASKED = " just asked you: "
TASK_FROM = re.compile(r"^Task from [^:]*: (.+)$", re.M)
# "look into X slowly" waits this long before reporting (demos and cancel tests).
SLOW_SECONDS = 30.0
_LEADING_VERB = re.compile(
    r"^(?:look into|research|dig into|investigate|find out|figure out)\s+", re.I
)
_FILLER_WORDS = frozenset("the and for with about into what when where which slowly".split())
SUMMARY_MARKER = "keeping meeting notes"
_TRANSCRIPT = re.compile(r"<transcript>\n(.*)\n</transcript>", re.S)
SOURCES_LINE = re.compile(
    r"^(?:Folders and repositories you can read|You have no folders).*$", re.M
)
_PHRASES: list[tuple[str, re.Pattern[str]]] = [
    ("read_file", re.compile(r"^read (?P<path>\S+?)(?: from (?P<source>\S+))?$", re.I)),
    (
        "search",
        re.compile(r"^(?:search(?: for)?|find) (?P<query>.+?)(?: in (?P<source>\S+))?$", re.I),
    ),
    ("remember", re.compile(r"^remember(?P<public> publicly)?(?: that)? (?P<note>.+)$", re.I)),
    ("forget", re.compile(r"^forget (?P<id>m_\w+)$", re.I)),
    ("recall", re.compile(r"^what do you remember about (?P<query>.+)$", re.I)),
]
_REPLIES = {
    "remember": "Got it, I'll remember that.",
    "forget": "Done, I've forgotten it.",
}


class OfflineModel:
    """A stand-in for Claude or Grok that understands a few fixed phrases.

    "read FILE [from SOURCE]", "search for X [in SOURCE]", "remember [publicly] that X",
    "forget ID", "what do you remember [about X]" and "what can you read" become real tool
    calls (or answers from the real system prompt), so the offline demo and the end-to-end
    tests exercise the real ToolBox, memory and scope rules. Anything else is echoed back.
    """

    def conversation(
        self,
        *,
        system: str,
        tools: Sequence[ToolSpec],
        mode: Mode = "answer",
        web_search: bool = False,
    ) -> OfflineConversation:
        return OfflineConversation(system, tools, mode)


class OfflineConversation:
    def __init__(self, system: str, tools: Sequence[ToolSpec], mode: Mode = "answer") -> None:
        self._system = system
        self._mode = mode
        self._tool_names = {t.name for t in tools}
        self._keyword = ""
        self._sources: list[str] = []
        for tool in tools:
            enum = tool.parameters.get("properties", {}).get("source", {}).get("enum")
            if enum:
                self._sources = list(enum)
                break
        self._calls = 0

    async def send(self, user: str) -> ModelTurn:
        from ..brain import ModelTurn

        if self._mode == "research":
            return await self._research(user)
        if SUMMARY_MARKER in self._system:
            # "Summarize" by keeping every line, so tests can see exactly what reached it.
            match = _TRANSCRIPT.search(user)
            return ModelTurn(
                answer=Answer("Meeting notes.", details=match.group(1) if match else "")
            )
        question = user.rsplit(ASKED, 1)[-1].strip()
        phrase = question.rstrip("?.! ")
        lowered = phrase.lower()
        if lowered == "what do you remember":
            return ModelTurn(answer=self._memories())
        if lowered in ("what can you read", "what sources do you have"):
            match = SOURCES_LINE.search(self._system)
            return ModelTurn(answer=Answer(match.group(0) if match else "I can't read any files."))
        for name, pattern in _PHRASES:
            if m := pattern.match(phrase):
                return self._call(name, {k: v for k, v in m.groupdict().items() if v is not None})
        return ModelTurn(answer=Answer(f"You asked: {question}"))

    def _memories(self) -> Answer:
        from ..brain import MEMORY_HEADING

        _, found, rest = self._system.partition(MEMORY_HEADING)
        block = rest.split("\n\n", 1)[0]
        if not found or not block.strip():
            return Answer("I don't remember anything yet.")
        return Answer("Here's what I remember.", details=block.strip())

    def _call(self, name: str, args: dict[str, Any]) -> ModelTurn:
        from ..brain import ModelTurn, ToolCall

        if name == "read_file" and "source" not in args:
            if not self._sources:
                return ModelTurn(answer=Answer("I have no files I can read for you."))
            args["source"] = self._sources[0]
        if name == "remember":
            args = {"note": args["note"], "public": "public" in args}
        self._calls += 1
        return ModelTurn(calls=(ToolCall(f"call_{self._calls}", name, args),))

    # -- research: search the sources for the task's key word, then report -----------

    async def _research(self, user: str) -> ModelTurn:
        match = TASK_FROM.search(user)
        title = match.group(1).strip() if match else user.strip()
        if "slowly" in title.lower():
            await asyncio.sleep(SLOW_SECONDS)
        words = [
            w
            for w in re.findall(r"[A-Za-z0-9']+", _LEADING_VERB.sub("", title))
            if len(w) > 2 and w.lower() not in _FILLER_WORDS
        ]
        self._keyword = max(words, key=len) if words else title
        if "search" not in self._tool_names:
            return self._report(f"I couldn't find anything about {self._keyword}.", "")
        return self._call("search", {"query": self._keyword})

    def _report(self, spoken: str, details: str) -> ModelTurn:
        from ..brain import REPORT_TOOL, ModelTurn, ToolCall

        self._calls += 1
        args: dict[str, object] = {"spoken": spoken, "details": details, "sources": []}
        return ModelTurn(calls=(ToolCall(f"call_{self._calls}", REPORT_TOOL.name, args),))

    async def send_results(self, results: Sequence[tuple[ToolCall, ToolResult]]) -> ModelTurn:
        from ..brain import ModelTurn

        if self._mode == "research":
            found = [
                r.content for _c, r in results if not r.is_error and "No matches" not in r.content
            ]
            if not found:
                return self._report(f"I couldn't find anything about {self._keyword}.", "")
            return self._report(f"Here's what I found about {self._keyword}.", "\n".join(found))

        for _call, result in results:
            if result.is_error:
                return ModelTurn(answer=Answer(f"Sorry, I can't: {result.content}."))
        call, result = results[-1]
        spoken = _REPLIES.get(call.name, "Here's what I found.")
        return ModelTurn(answer=Answer(spoken, details=result.content))
