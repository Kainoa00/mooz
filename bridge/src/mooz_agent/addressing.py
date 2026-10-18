"""Decide whether something said or typed in the meeting is addressed to this agent.

Being mentioned ("I asked Atlas yesterday") is not being addressed ("Atlas, what's
blocking the deploy?"). The rules are deliberately simple and predictable: the name
(or a likely mis-transcription of it) must open the utterance, optionally after a
greeting, or close a question. `@Name` in chat always works as a deterministic path.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from rapidfuzz import fuzz

GREETINGS = frozenset("hey hi hello ok okay yo so um uh and well oh alright right".split())
# A name followed directly by these (without a comma) is being talked about.
REPORTING = frozenset(
    "said says told tells thinks thought mentioned was wasn't is isn't has had did didn't "
    "does doesn't knows knew wrote suggested project team".split()
)
QUESTION_OPENERS = frozenset(
    "what why how when where who which whose can could would will is are am do does did "
    "should shall any have has was were".split()
)
# A name right after these is the object of a sentence, not someone being spoken to.
OBJECT_MARKERS = frozenset("ask asked tell told to about with from for the at of by".split())
BROADCAST_VOICE = ("agents",)
BROADCAST_CHAT = ("everyone", "agents")
# A heard word matches the name if it sounds alike AND is spelled close, or is spelled
# very close. Sound alone is too loose ("could" sounds like "Claude").
SOUND_ALIKE_MIN_RATIO = 75
SPELLED_ALIKE_MIN_RATIO = 90

_WORD = re.compile(r"[A-Za-z0-9']+")
_EDGE_PUNCT = " \t,.:;!-"


@dataclass(frozen=True)
class Addressed:
    """The agent was addressed. `question` may be empty ("Hey Atlas.")."""

    question: str
    via: Literal["voice", "chat"]


@dataclass(frozen=True)
class _Token:
    norm: str
    possessive: bool
    start: int
    end: int


def phonetic_key(word: str) -> str:
    """A crude sound-alike key: first letter, then consonants with near-homophones merged."""
    w = word.lower()
    w = re.sub(r"[^a-z]", "", w)
    if not w:
        return ""
    for src, dst in (("ph", "f"), ("ck", "k"), ("q", "k"), ("c", "k"), ("z", "s"), ("x", "ks")):
        w = w.replace(src, dst)
    head, tail = w[0], re.sub(r"[aeiouyhw]", "", w[1:])
    key = head
    for ch in tail:
        if ch != key[-1]:
            key += ch
    return key


def _tokens(text: str) -> list[_Token]:
    out = []
    for m in _WORD.finditer(text):
        raw = m.group(0).lower()
        possessive = raw.endswith("'s")
        norm = raw[:-2] if possessive else raw.strip("'")
        out.append(_Token(norm, possessive, m.start(), m.end()))
    return out


def _same_word(heard: str, wake: str) -> bool:
    if heard == wake:
        return True
    if len(heard) < 3:
        return False
    ratio = fuzz.ratio(heard, wake)
    if ratio >= SPELLED_ALIKE_MIN_RATIO:
        return True
    return ratio >= SOUND_ALIKE_MIN_RATIO and phonetic_key(heard) == phonetic_key(wake)


class AddressDetector:
    def __init__(self, name: str) -> None:
        self.name = name
        words = [t.norm for t in _tokens(name)]
        forms = [words]
        if len(words) > 1:
            forms.append(words[-1:])  # "Zach's Grok" also answers to "Grok"
        self._forms = forms
        mentionable = [name.strip(), *(" ".join(f) for f in forms[1:]), *BROADCAST_CHAT]
        self._chat_mention = re.compile(
            r"(?<![\w.@])@(" + "|".join(re.escape(m) for m in mentionable) + r")\b",
            re.IGNORECASE,
        )

    def check(self, text: str, via: Literal["voice", "chat"]) -> Addressed | None:
        if via == "chat":
            mention = self._chat_mention.search(_normalize_possessives(text))
            if mention:
                rest = (text[: mention.start()] + text[mention.end() :]).strip(_EDGE_PUNCT + " ")
                return Addressed(re.sub(r"\s+", " ", rest), via)
        return self._check_spoken(text, via)

    def _check_spoken(self, text: str, via: Literal["voice", "chat"]) -> Addressed | None:
        tokens = _tokens(text)
        if not tokens:
            return None
        forms = [*self._forms, *([w] for w in BROADCAST_VOICE)]
        broadcast = {tuple([w]) for w in BROADCAST_VOICE}
        for form in forms:
            for i in range(len(tokens) - len(form) + 1):
                window = tokens[i : i + len(form)]
                if not all(_same_word(t.norm, w) for t, w in zip(window, form, strict=True)):
                    continue
                found = self._judge(
                    text, tokens, i, i + len(form) - 1, via, strict=tuple(form) in broadcast
                )
                if found is not None:
                    return found
        return None

    def _judge(
        self,
        text: str,
        tokens: list[_Token],
        first: int,
        last: int,
        via: Literal["voice", "chat"],
        strict: bool = False,
    ) -> Addressed | None:
        name_end = tokens[last].end
        before, after = tokens[:first], tokens[last + 1 :]
        comma_after = bool(re.match(r"\s*[,.:;!?]", text[name_end:]))
        comma_before = bool(re.search(r"[,;:]\s*$", text[: tokens[first].start]))

        opens = len(before) <= 3 and all(t.norm in GREETINGS for t in before)
        # "Agents" is an ordinary word, so as a wake word it must be set off: "Hey agents, ..."
        if strict and not (opens and comma_after):
            return None
        if opens:
            if tokens[last].possessive:
                return None
            if after and not comma_after and after[0].norm in REPORTING:
                return None
            return Addressed(text[name_end:].lstrip(_EDGE_PUNCT + "?").strip(), via)

        closes = not after and before[-1].norm not in OBJECT_MARKERS
        is_question = text.rstrip().endswith("?") or tokens[0].norm in QUESTION_OPENERS
        # "..., Atlas." closing a request is a vocative even when it is not a question.
        if closes and (is_question or comma_before):
            return Addressed(text[: tokens[first].start].rstrip(_EDGE_PUNCT + " "), via)
        return None


def _normalize_possessives(text: str) -> str:
    # Phones type curly apostrophes (U+2019); match them like straight ones.
    return text.replace("\u2019", "'")
