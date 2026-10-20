"""What the agent remembers of the meeting: a short rolling window, held in memory only."""

from __future__ import annotations

import re
import time
import unicodedata
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
    # For an agent's reply (used by notes opt-outs): the person it answers, and everyone
    # whose words were in what it was given, so it may repeat them.
    about: str | None = None
    sources: frozenset[str] = frozenset()


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
        included: list[Utterance] | None = None,
    ) -> str:
        """The transcript as the model sees it, newest lines kept when it is too long.

        With `roles`, each message is one line tagged with the speaker's server-derived role
        (see `render_line`), so nothing anyone says can pass as someone else's line. The lines
        that made it in are appended to `included`.
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
            if included is not None:
                included.append(u)
        return "\n".join(reversed(lines))

    def _evict(self) -> None:
        cutoff = self._clock() - self._window
        while self._items and self._items[0].timestamp < cutoff:
            self._items.popleft()


# Everything Python (and so a model's tokenizer view of "a new line") treats as a line break.
_LINE_BREAKS = re.compile(r"\r\n|[\r\n\v\f\x1c-\x1e\x85\u2028\u2029]")
# A typed line break, shown inside the line so what follows can't pass for a new message.
BREAK = " \u23ce "

# What emoji and scripts need, kept once: a joiner (Persian and Indic text use them too) or a
# presentation selector (❤️). A run of them keeps at most one selector, then one joiner.
_SELECTORS = "\ufe0e\ufe0f"
_JOINERS = "\u200c\u200d"
# The three standard subdivision flags (England, Scotland, Wales) keep their tag letters.
_FLAGS = tuple(
    "\U0001f3f4" + "".join(chr(0xE0000 + ord(c)) for c in code) + "\U000e007f"
    for code in ("gbeng", "gbsct", "gbwls")
)


def _hidden(ch: str) -> bool:
    """Shows as nothing and can carry hidden text: format, private-use and surrogate code
    points, and the variation selectors that can smuggle bytes after an emoji."""
    cp = ord(ch)
    return (
        unicodedata.category(ch) in ("Cf", "Co", "Cs")
        or 0xFE00 <= cp <= 0xFE0D
        or 0xE0100 <= cp <= 0xE01EF
    )


def _clean(text: str) -> str:
    out: list[str] = []
    i = 0
    while i < len(text):
        flag = next((f for f in _FLAGS if text.startswith(f, i)), None)
        if flag:
            out.append(flag)
            i += len(flag)
            continue
        ch = text[i]
        if ch in _SELECTORS or ch in _JOINERS:
            j = i
            while j < len(text) and (text[j] in _SELECTORS or text[j] in _JOINERS):
                j += 1
            run = text[i:j]
            out.append(next((c for c in run if c in _SELECTORS), ""))
            out.append(next((c for c in run if c in _JOINERS), ""))
            i = j
            continue
        if not _hidden(ch):
            out.append(ch)
        i += 1
    return "".join(out)


def flatten(text: str, *, markup: bool = True) -> str:
    """One visible line: no kind of line break or hidden character can fake structure.

    Lookalikes are normalized first (a fullwidth "</transcript>" is escaped too). With
    `markup`, angle brackets are escaped, so text can't close a <transcript> block. These are
    the web app's rules too (apps/web/lib/text.ts); tests/text_cases.json keeps them the same.
    """
    flat = _LINE_BREAKS.sub(BREAK, _clean(unicodedata.normalize("NFKC", _clean(text))))
    return flat.replace("<", "&lt;").replace(">", "&gt;") if markup else flat


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
