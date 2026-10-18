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

    def render(
        self,
        max_chars: int = 12_000,
        *,
        roles: Callable[[Speaker], str] | None = None,
        exclude: Callable[[Utterance], bool] | None = None,
    ) -> str:
        """The transcript as the model sees it, newest lines kept when it is too long.

        With `roles`, each message is one line tagged with the speaker's server-derived role
        (see `render_line`), so nothing anyone says can pass as someone else's line.
        """
        lines: list[str] = []
        size = 0
        for u in reversed(self.recent()):
            if exclude is not None and exclude(u):
                continue
            line = render_line(u, roles)
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


def flatten(text: str) -> str:
    """One line, with no markup: newlines and angle brackets can't fake structure."""
    return (
        text.replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\n", "\\n")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def render_line(u: Utterance, roles: Callable[[Speaker], str] | None = None) -> str:
    if roles is None:
        return f"{_label(u)}: {u.text}"
    # Names are chosen by people; only the bracketed role comes from the server.
    name = flatten(u.speaker.name).replace("[", "").replace("]", "").strip()
    via = " (chat)" if u.via == "chat" and u.speaker.kind == "human" else ""
    return f"[{roles(u.speaker)}] {name}{via}: {flatten(u.text)}"


def _label(u: Utterance) -> str:
    if u.speaker.kind == "agent":
        return f"{u.speaker.name} (agent)"
    if u.via == "chat":
        return f"{u.speaker.name} (chat)"
    return u.speaker.name
