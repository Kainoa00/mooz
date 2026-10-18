"""Opt-in meeting notes: a log of what was said, summarized into the owner's private memory.

Consent comes from the room, not from the agent: the host allows notes (room metadata) and
anyone can leave themselves out (a participant attribute), both set only by the mooz server.
Opt-outs are checked when a line is heard and again before anything is summarized, so leaving
mid-meeting also covers what you said earlier. Only the summary is saved; the log is not.
"""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Callable
from typing import Literal, Protocol

from .memory import MAX_NOTE_CHARS, MEETING_NOTES_TAG, MemoryStore, Note
from .room import Speaker
from .transcript import Utterance, render_line

NOTES_TAG = MEETING_NOTES_TAG
NOTES_INTERVAL_SECONDS = 15 * 60
# Summarize early rather than let one chunk grow past what a summary prompt should hold.
MAX_LOG_CHARS = 60_000

_ON = re.compile(
    r"^(?:please )?(?:(?:can|could|would|will) you )?(?:please )?(?:start )?"
    r"(?:keep|keeping|take|taking) (?:meeting )?notes(?: please)?$"
)
_OFF = re.compile(r"^(?:please )?stop (?:keeping|taking) (?:meeting )?notes(?: please)?$")


def notes_command(text: str) -> Literal["on", "off"] | None:
    """'keep notes' / 'stop keeping notes' and close variants; anything longer is a question."""
    phrase = " ".join(re.sub(r"[^\w\s']", " ", text.lower()).split())
    if _OFF.match(phrase):
        return "off"
    if _ON.match(phrase):
        return "on"
    return None


class Summarizer(Protocol):
    async def summarize(self, *, transcript: str) -> str: ...


def _when(ts: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))


class NotesKeeper:
    def __init__(
        self,
        *,
        summarizer: Summarizer,
        memory: MemoryStore,
        opted_out: Callable[[str], bool],
        render: Callable[[Utterance], str] = render_line,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._summarizer = summarizer
        self._render = render
        self._memory = memory
        self._opted_out = opted_out
        self._clock = clock
        self._log: list[Utterance] = []
        self._size = 0
        self._since: float | None = None
        self._lock = asyncio.Lock()
        self.active = False

    def _excluded(self, speaker: Speaker) -> bool:
        # A person's agent speaks for them, so it is left out with them.
        who = speaker.owner_identity if speaker.kind == "agent" else speaker.identity
        return self._opted_out(speaker.identity) or (who is not None and self._opted_out(who))

    def start(self) -> None:
        if not self.active:
            self.active = True
            self._since = self._clock()

    def hear(self, u: Utterance) -> bool:
        """Log a line if notes are on and the speaker hasn't opted out. True when full."""
        if not self.active or self._excluded(u.speaker):
            return False
        self._log.append(u)
        self._size += len(u.text)
        return self._size >= MAX_LOG_CHARS

    async def flush(self) -> Note | None:
        """Summarize what was logged since the last flush into private memory."""
        async with self._lock:
            lines = [u for u in self._log if not self._excluded(u.speaker)]
            since, now = self._since, self._clock()
            self._log, self._size = [], 0
            self._since = now if self.active else None
            if not lines:
                return None
            saving = False
            try:
                summary = await self._summarizer.summarize(
                    transcript="\n".join(self._render(u) for u in lines)
                )
                start = _when(since if since is not None else lines[0].timestamp)
                text = f"Meeting notes ({start} to {_when(now)}):\n{summary}"[:MAX_NOTE_CHARS]
                saving = True
                return await asyncio.to_thread(
                    self._memory.remember, text, public=False, tags=[NOTES_TAG]
                )
            except BaseException:
                # Not summarized (failed or cancelled): keep the lines for the next try.
                # Once saving has started the note is written anyway, so don't double it.
                if not saving:
                    self._log = lines + self._log
                    self._size = sum(len(u.text) for u in self._log)
                    self._since = since
                raise

    async def stop(self) -> Note | None:
        self.active = False
        return await self.flush()
