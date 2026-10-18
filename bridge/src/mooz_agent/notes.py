"""Opt-in meeting notes: a log of what was said, summarized into the owner's private memory.

Consent comes from the room, not from the agent: the host allows notes (room metadata) and
anyone can leave themselves out (a participant attribute), both set only by the mooz server.

A line belongs to its speaker (an agent's line also to its owner) and, for an agent's reply,
to the person it answers. It is kept only if all of them have been told notes are on and none
has opted out. Opt-outs are checked again before summarizing, so leaving mid-meeting also
covers what you said earlier. Only the summary is saved; the log is not.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Callable
from dataclasses import replace
from typing import Literal, Protocol

from .memory import MAX_NOTE_CHARS, MEETING_NOTES_TAG, MemoryStore, Note
from .transcript import Utterance, render_line

log = logging.getLogger(__name__)

NOTES_TAG = MEETING_NOTES_TAG
NOTES_INTERVAL_SECONDS = 15 * 60
# Summarize early rather than let one chunk grow past what a summary prompt should hold.
MAX_LOG_CHARS = 60_000
# If summaries keep failing, keep at most this much (oldest lines go first).
MAX_LOG_CHARS_HARD = 4 * MAX_LOG_CHARS
# One very long message is cut, so nobody can make the owner pay for a huge summary.
MAX_LINE_CHARS = 2_000
# After a failed summary, wait this long before summarizing early again.
RETRY_SECONDS = 120.0

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
        admitted: Callable[[str], bool] = lambda _identity: True,
        render: Callable[[Utterance], str] = render_line,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._summarizer = summarizer
        self._render = render
        self._memory = memory
        self._opted_out = opted_out
        self._admitted = admitted
        self._clock = clock
        self._log: list[Utterance] = []
        self.size = 0
        self._since: float | None = None
        self._lock = asyncio.Lock()
        self._flush_wanted = False
        self._retry_after = 0.0
        self.active = False

    @staticmethod
    def _people(u: Utterance) -> list[str]:
        """The people a line belongs to (an agent speaks for its owner)."""
        people = [u.speaker.identity]
        if u.speaker.kind == "agent" and u.speaker.owner_identity:
            people.append(u.speaker.owner_identity)
        if u.about:
            people.append(u.about)
        return people

    def excluded(self, u: Utterance) -> bool:
        """True if anyone this line belongs to has opted out of notes."""
        return any(self._opted_out(p) for p in self._people(u))

    def _told(self, u: Utterance) -> bool:
        # Agents don't see the banner; their owners do.
        people = [u.speaker.owner_identity] if u.speaker.kind == "agent" else [u.speaker.identity]
        if u.about:
            people.append(u.about)
        return all(self._admitted(p) for p in people if p)

    @property
    def unsaved(self) -> bool:
        return bool(self._log)

    def start(self) -> None:
        if not self.active:
            self.active = True
            self._since = self._clock()

    def hear(self, u: Utterance) -> bool:
        """Log a line if notes are on and it may be kept. True when it's time to flush early."""
        if not self.active or self.excluded(u) or not self._told(u):
            return False
        if len(u.text) > MAX_LINE_CHARS:
            u = replace(u, text=u.text[:MAX_LINE_CHARS] + " …")
        self._log.append(u)
        self.size += len(u.text)
        if self.size > MAX_LOG_CHARS_HARD:
            log.warning("meeting notes are backing up; dropping the oldest lines")
            while self.size > MAX_LOG_CHARS_HARD and self._log:
                self.size -= len(self._log.pop(0).text)
        ready = self.size >= MAX_LOG_CHARS and self._clock() >= self._retry_after
        if ready and not self._flush_wanted:
            self._flush_wanted = True  # one early flush at a time
            return True
        return False

    async def flush(self) -> Note | None:
        """Summarize what was logged since the last flush into private memory."""
        async with self._lock:
            try:
                return await self._flush_locked()
            except Exception:
                self._retry_after = self._clock() + RETRY_SECONDS
                raise
            finally:
                self._flush_wanted = False

    async def _flush_locked(self) -> Note | None:
        lines = [u for u in self._log if not self.excluded(u)]
        since, now = self._since, self._clock()
        self._log, self.size = [], 0
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
                self.size = sum(len(u.text) for u in self._log)
                self._since = since
            raise

    async def stop(self) -> Note | None:
        self.active = False
        return await self.flush()
