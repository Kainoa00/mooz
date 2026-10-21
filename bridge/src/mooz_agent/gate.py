"""The speech gate: which audio of a track to transcribe, cut into utterances.

The same gate runs in the connector tab (apps/web/lib/voice/gate.ts); both run
tests/gate_cases.json, so the bridge and the tab cut speech alike.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TypedDict

import numpy as np
import numpy.typing as npt

SAMPLE_RATE = 16_000
# Louder than this (RMS, full scale = 1) counts as someone talking: about -42 dBFS.
SPEECH_LEVEL = 0.008
# Audio kept from just before speech starts, so the first word ("Hey…") isn't clipped.
PRE_ROLL_MS = 600
HANGOVER_MS = 1500

Pcm = npt.NDArray[np.int16]


class GateOptions(TypedDict, total=False):
    level: float
    pre_roll_ms: int
    hangover_ms: int  # quiet that ends an utterance
    max_utterance_ms: int  # an utterance this long is cut and goes on as a new one (0: never)
    min_speech_ms: int  # less speech than this isn't worth transcribing (a cough, a click)


# For a local speech server, which transcribes one utterance per request.
LOCAL_GATE: GateOptions = {"hangover_ms": 700, "max_utterance_ms": 15_000, "min_speech_ms": 300}


def rms(pcm: Pcm) -> float:
    if pcm.size == 0:
        return 0.0
    return float(np.sqrt(np.mean((pcm.astype(np.float64) / 0x8000) ** 2)))


def _samples(ms: float) -> float:
    return ms / 1000 * SAMPLE_RATE


@dataclass
class GateOutput:
    frames: list[Pcm]  # to transcribe now, oldest first
    commit: bool = False  # the last frame of an utterance
    keep: bool = True  # with a commit: whether it had enough speech to transcribe


@dataclass
class SpeechGate:
    """Passes a track's 16 kHz audio only while someone talks (plus a little either side).

    Time is counted in samples, not clock time.
    """

    level: float = SPEECH_LEVEL
    pre_roll_ms: int = PRE_ROLL_MS
    hangover_ms: int = HANGOVER_MS
    max_utterance_ms: int = 0
    min_speech_ms: int = 0
    _buffered: list[Pcm] = field(default_factory=list)
    _buffered_samples: int = 0
    _open: bool = False
    _quiet_for: int = 0
    _utterance: int = 0
    _speech: int = 0

    def push(self, frame: Pcm) -> GateOutput:
        loud = rms(frame) >= self.level
        if self._open:
            self._utterance += frame.size
            if loud:
                self._speech += frame.size
            self._quiet_for = 0 if loud else self._quiet_for + frame.size
            if self._quiet_for >= _samples(self.hangover_ms):
                self._open = False
                return self._cut(frame)
            # Too long to send as one: cut here, and the speech goes on as a new utterance.
            if self.max_utterance_ms > 0 and self._utterance >= _samples(self.max_utterance_ms):
                return self._cut(frame)
            return GateOutput([frame])
        if loud:
            frames = [*self._buffered, frame]
            self._utterance = self._buffered_samples + frame.size
            self._speech = frame.size
            self._buffered = []
            self._buffered_samples = 0
            self._open = True
            self._quiet_for = 0
            return GateOutput(frames)
        self._buffered.append(frame)
        self._buffered_samples += frame.size
        pre_roll = _samples(self.pre_roll_ms)
        while len(self._buffered) > 1:
            if self._buffered_samples - self._buffered[0].size < pre_roll:
                break
            self._buffered_samples -= self._buffered.pop(0).size
        return GateOutput([])

    def _cut(self, frame: Pcm) -> GateOutput:
        keep = self._speech >= _samples(self.min_speech_ms)
        self._utterance = 0
        self._speech = 0
        self._quiet_for = 0
        return GateOutput([frame], commit=True, keep=keep)
