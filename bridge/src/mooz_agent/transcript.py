"""What the agent remembers of the meeting: a short rolling window, held in memory only."""

from __future__ import annotations

import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from .room import Speaker


@dataclass(frozen=True)
class Utterance:
    speaker: Speaker
    text: str
    timestamp: float
    via: Literal["voice", "chat"]


class TranscriptBuffer:
    def __init__(self, window_seconds: float = 600, clock: Callable[[], float] = time.time) -> None:
        self._window = window_seconds
        self._clock = clock
        self._items: deque[Utterance] = deque()

    def add(self, utterance: Utterance) -> None:
        self._items.append(utterance)
        self._evict()

    def recent(self) -> list[Utterance]:
        self._evict()
        return list(self._items)

    def render(self, max_chars: int = 12_000) -> str:
        """The transcript as the model sees it, newest lines kept when it is too long."""
        lines: list[str] = []
        size = 0
        for u in reversed(self.recent()):
            line = f"{_label(u)}: {u.text}"
            added = len(line) + (1 if lines else 0)
            if size + added > max_chars:
                break
            lines.append(line)
            size += added
        return "\n".join(reversed(lines))

    def _evict(self) -> None:
        cutoff = self._clock() - self._window
        while self._items and self._items[0].timestamp < cutoff:
            self._items.popleft()


def _label(u: Utterance) -> str:
    if u.speaker.kind == "agent":
        return f"{u.speaker.name} (agent)"
    if u.via == "chat":
        return f"{u.speaker.name} (chat)"
    return u.speaker.name
