"""Local voice: any OpenAI-compatible speech server on the owner's side (VoiceStudio, Speaches,
Kokoro-FastAPI, whisper.cpp...). Hearing cuts each person's audio into utterances with the
speech gate and sends one WAV per utterance to `/audio/transcriptions`; speaking asks
`/audio/speech` for one sentence at a time. Nothing goes to the mooz server.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import logging
import re
import struct
import time
import wave
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlsplit

import httpx
import numpy as np
from livekit import rtc

from ..gate import LOCAL_GATE, SAMPLE_RATE, Pcm, SpeechGate
from ..room import Speaker

log = logging.getLogger(__name__)

DEFAULT_SPEECH_URL = "http://127.0.0.1:3900/v1"
Format = Literal["pcm", "wav"]
# Utterances waiting to be transcribed, per person; past this the oldest is dropped.
MAX_BACKLOG = 4
STT_TIMEOUT = httpx.Timeout(10.0, read=30.0)
# On a CPU a server may think for a while before the first audio comes.
TTS_TIMEOUT = httpx.Timeout(10.0, read=60.0)
CHECK_TIMEOUT = 5.0
WARN_EVERY_SECONDS = 60.0
FRAME_MS = 20
# Shorter sentences go with the next one: a request each would only add gaps.
MIN_SENTENCE_CHARS = 12
# Whisper-style models "hear" these in silence and noise. On a short clip, they're dropped.
SILENCE_PHRASES = frozenset(
    {"thank you", "thanks", "thank you very much", "thanks for watching", "thank you for watching",
     "you", "bye", "bye bye", "okay", "so", "hmm", "uh", "um"}
)  # fmt: skip
SILENCE_CLIP_SECONDS = 1.5


class SpeechServerError(Exception):
    """The local speech server is misconfigured, unreachable, or refused a request."""


def _loopback(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return host in ("localhost", "::1") or host.startswith("127.")


@dataclass(frozen=True)
class LocalSpeech:
    """Where the speech server is and what to ask it for."""

    stt_url: str = DEFAULT_SPEECH_URL
    tts_url: str = DEFAULT_SPEECH_URL
    stt_model: str = "whisper-1"
    tts_model: str = "tts-1"
    voice: str = "default"
    tts_format: Format = "pcm"
    tts_rate: int = 24_000  # of raw pcm (OpenAI's is 24 kHz); wav says its own
    api_key: str | None = None
    language: str = "en"
    stt_concurrency: int = 2

    @classmethod
    def from_env(
        cls, env: Mapping[str, str], *, voice: str | None = None, language: str = "en"
    ) -> LocalSpeech:
        def get(name: str) -> str | None:
            return (env.get(name) or "").strip() or None

        base = get("MOOZ_SPEECH_URL") or DEFAULT_SPEECH_URL
        urls = [(get(n) or base).rstrip("/") for n in ("MOOZ_STT_URL", "MOOZ_TTS_URL")]
        for url in urls:
            if urlsplit(url).scheme not in ("http", "https") or not urlsplit(url).hostname:
                raise SpeechServerError(f"The speech server address must be http(s)://…, not {url}")
        fmt = get("MOOZ_TTS_FORMAT") or "pcm"
        if fmt not in ("pcm", "wav"):
            raise SpeechServerError(f"MOOZ_TTS_FORMAT is pcm or wav, not {fmt!r}")
        try:
            rate = int(get("MOOZ_TTS_RATE") or 24_000)
            slots = int(get("MOOZ_STT_CONCURRENCY") or 2)
        except ValueError as err:
            raise SpeechServerError(
                f"MOOZ_TTS_RATE and MOOZ_STT_CONCURRENCY are numbers: {err}"
            ) from err
        if not 8_000 <= rate <= 96_000 or not 1 <= slots <= 8:
            raise SpeechServerError("MOOZ_TTS_RATE is 8000-96000 and MOOZ_STT_CONCURRENCY is 1-8")
        return cls(
            stt_url=urls[0],
            tts_url=urls[1],
            stt_model=get("MOOZ_STT_MODEL") or "whisper-1",
            tts_model=get("MOOZ_TTS_MODEL") or "tts-1",
            voice=voice or get("MOOZ_TTS_VOICE") or "default",
            tts_format=fmt,  # type: ignore[arg-type]
            tts_rate=rate,
            api_key=get("MOOZ_SPEECH_API_KEY"),
            language=language,
            stt_concurrency=slots,
        )

    @property
    def headers(self) -> dict[str, str]:
        return {"authorization": f"Bearer {self.api_key}"} if self.api_key else {}

    @property
    def urls(self) -> list[str]:
        return sorted({self.stt_url, self.tts_url})


def speech_problem(settings: LocalSpeech) -> str | None:
    """A setting that must not be used: a key sent in the clear to another machine."""
    if settings.api_key and any(
        urlsplit(u).scheme == "http" and not _loopback(u) for u in settings.urls
    ):
        return (
            "Use https:// for a speech server on another machine, or no key: "
            "MOOZ_SPEECH_API_KEY would go to it unencrypted."
        )
    return None


def speech_warning(settings: LocalSpeech) -> str | None:
    remote = [u for u in settings.urls if urlsplit(u).scheme == "http" and not _loopback(u)]
    if remote:
        host = urlsplit(remote[0]).hostname
        return (
            f"Everyone's audio goes to {host} unencrypted (http). Use https://, or an SSH tunnel."
        )
    return None


async def check_speech_server(http: httpx.AsyncClient, settings: LocalSpeech) -> None:
    """Before joining: the server is there (a server without /models still counts)."""
    for url in settings.urls:
        try:
            res = await http.get(f"{url}/models", headers=settings.headers, timeout=CHECK_TIMEOUT)
        except httpx.HTTPError as err:
            raise SpeechServerError(
                f"Can't reach your speech server at {url} ({type(err).__name__}). Is it running?"
            ) from err
        if res.status_code in (401, 403):
            raise SpeechServerError(
                f"Your speech server at {url} refused the request ({res.status_code}): check "
                "MOOZ_SPEECH_API_KEY."
            )


def _wav_bytes(pcm: Pcm, rate: int) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.astype("<i2").tobytes())
    return out.getvalue()


def _plain(text: str) -> str:
    return re.sub(r"[^a-z ]", "", text.lower()).strip()


class LocalSTT:
    """Hears each person through the speech gate: one request per utterance."""

    def __init__(
        self,
        settings: LocalSpeech,
        http: httpx.AsyncClient,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._settings = settings
        self._http = http
        self._clock = clock
        self._slots = asyncio.Semaphore(settings.stt_concurrency)
        self._warned: dict[str, float] = {}

    async def transcribe(
        self, speaker: Speaker, frames: AsyncIterator[rtc.AudioFrame]
    ) -> AsyncIterator[str]:
        clips: asyncio.Queue[Pcm | None] = asyncio.Queue()
        failure: list[BaseException] = []

        async def cut() -> None:
            gate = SpeechGate(**LOCAL_GATE)
            buffer: list[Pcm] = []
            try:
                async for frame in frames:
                    out = gate.push(np.frombuffer(frame.data, dtype=np.int16))
                    buffer.extend(out.frames)
                    if not out.commit:
                        continue
                    clip, buffer = buffer, []
                    if not out.keep:
                        continue
                    if clips.qsize() >= MAX_BACKLOG:
                        clips.get_nowait()
                        self._warn("behind", "your speech server is behind: skipped an utterance")
                    clips.put_nowait(np.concatenate(clip))
            except Exception as err:  # the track's audio failed: the listener retries
                failure.append(err)
            finally:
                clips.put_nowait(None)

        cutting = asyncio.ensure_future(cut())
        try:
            while (clip := await clips.get()) is not None:
                text = await self._recognize(clip)
                if text:
                    yield text
            if failure:
                raise failure[0]
        finally:
            cutting.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await cutting

    async def _recognize(self, pcm: Pcm) -> str:
        s = self._settings
        url = f"{s.stt_url}/audio/transcriptions"
        fields = {"model": s.stt_model, "language": s.language, "response_format": "json"}
        fields["temperature"] = "0"
        async with self._slots:
            try:
                res = await self._http.post(
                    url,
                    data=fields,
                    files={"file": ("speech.wav", _wav_bytes(pcm, SAMPLE_RATE), "audio/wav")},
                    headers=s.headers,
                    timeout=STT_TIMEOUT,
                )
            except httpx.HTTPError as err:
                self._warn("unreachable", f"can't reach your speech server ({type(err).__name__})")
                return ""
        if res.status_code >= 400:
            self._warn("refused", f"your speech server refused to transcribe ({res.status_code})")
            return ""
        try:
            body = res.json()
            text = str(body.get("text", "")).strip() if isinstance(body, dict) else ""
        except ValueError:
            self._warn("garbled", "your speech server's transcription wasn't JSON")
            return ""
        if pcm.size / SAMPLE_RATE < SILENCE_CLIP_SECONDS and _plain(text) in SILENCE_PHRASES:
            return ""
        return text

    def _warn(self, kind: str, message: str) -> None:
        now = self._clock()
        if now - self._warned.get(kind, float("-inf")) >= WARN_EVERY_SECONDS:
            self._warned[kind] = now
            log.warning("%s; skipping what was said", message)


class PcmFrames:
    """Raw 16-bit mono PCM, in chunks split anywhere, as 20 ms frames."""

    def __init__(self, rate: int) -> None:
        self._rate = rate
        self._size = rate * FRAME_MS // 1000 * 2
        self._pending = bytearray()

    def feed(self, chunk: bytes) -> list[rtc.AudioFrame]:
        self._pending += chunk
        out = []
        while len(self._pending) >= self._size:
            out.append(self._frame(bytes(self._pending[: self._size])))
            del self._pending[: self._size]
        return out

    def flush(self) -> list[rtc.AudioFrame]:
        rest = bytes(self._pending[: len(self._pending) // 2 * 2])
        self._pending.clear()
        return [self._frame(rest)] if rest else []

    def _frame(self, data: bytes) -> rtc.AudioFrame:
        return rtc.AudioFrame(data, self._rate, 1, len(data) // 2)


class WavFrames:
    """A (streamed) WAV: the rate comes from its header, and stereo comes down to mono."""

    def __init__(self) -> None:
        self._head = bytearray()
        self._channels = 0
        self._pcm: PcmFrames | None = None
        self._pending = bytearray()

    def feed(self, chunk: bytes) -> list[rtc.AudioFrame]:
        if self._pcm is None:
            self._head += chunk
            data = self._parse_header()
            if data is None:
                return []
            chunk = data
        assert self._pcm is not None
        self._pending += chunk
        width = 2 * self._channels
        usable = len(self._pending) // width * width
        samples = np.frombuffer(bytes(self._pending[:usable]), dtype="<i2")
        del self._pending[:usable]
        if self._channels > 1:
            mixed = samples.reshape(-1, self._channels).astype(np.int32).mean(axis=1)
            samples = np.round(mixed).astype(np.int16)
        return self._pcm.feed(samples.astype("<i2").tobytes())

    def flush(self) -> list[rtc.AudioFrame]:
        return self._pcm.flush() if self._pcm else []

    def _parse_header(self) -> bytes | None:
        """The audio after the header, once the whole header has arrived (None before)."""
        head = bytes(self._head)
        if len(head) < 12:
            return None
        if head[:4] != b"RIFF" or head[8:12] != b"WAVE":
            raise SpeechServerError("Your speech server's audio isn't WAV")
        pos = 12
        while len(head) >= pos + 8:
            kind, size = head[pos : pos + 4], struct.unpack("<I", head[pos + 4 : pos + 8])[0]
            if kind == b"data":
                if not self._channels:
                    raise SpeechServerError("Your speech server's WAV has no format")
                return head[pos + 8 :]
            if len(head) < pos + 8 + size:
                return None
            if kind == b"fmt ":
                _fmt, channels, rate, _bps, _align, bits = struct.unpack(
                    "<HHIIHH", head[pos + 8 : pos + 24]
                )
                if bits != 16:
                    raise SpeechServerError(f"Your speech server's WAV is {bits}-bit, not 16-bit")
                self._channels = channels
                self._pcm = PcmFrames(rate)
            pos += 8 + size + (size & 1)
        return None


def split_sentences(text: str) -> list[str]:
    pieces = [p.strip() for p in re.split(r"(?<=[.!?])\s+", text.strip()) if p.strip()]
    sentences: list[str] = []
    carry = ""
    for piece in pieces:
        piece = f"{carry} {piece}".strip() if carry else piece
        if len(piece) < MIN_SENTENCE_CHARS:
            carry = piece
            continue
        sentences.append(piece)
        carry = ""
    if carry:
        sentences.append(carry)
    return sentences


class LocalTTS:
    """Speaks one sentence per request, fetching the next while this one plays."""

    def __init__(self, settings: LocalSpeech, http: httpx.AsyncClient) -> None:
        self._settings = settings
        self._http = http
        self._cache: dict[str, list[rtc.AudioFrame]] = {}

    async def warm(self, phrases: Sequence[str]) -> None:
        """Make the fixed phrases ("Yes?") once now, then say them from memory.

        On a local server this also wakes the model, which may have gone to sleep.
        """
        for phrase in phrases:
            try:
                self._cache[phrase.strip()] = [f async for f in self._fetch(phrase)]
            except Exception as err:
                log.warning("couldn't prepare %r with your speech server: %s", phrase, err)

    async def synthesize(self, text: str) -> AsyncIterator[rtc.AudioFrame]:
        cached = self._cache.get(text.strip())
        if cached is not None:
            for frame in cached:
                yield frame
            return
        sentences = split_sentences(text)
        ahead: asyncio.Task[list[rtc.AudioFrame]] | None = None

        def fetch_next(i: int) -> asyncio.Task[list[rtc.AudioFrame]] | None:
            if i >= len(sentences):
                return None
            return asyncio.ensure_future(self._collect(sentences[i]))

        try:
            for i, sentence in enumerate(sentences):
                if i == 0:
                    async for frame in self._fetch(sentence):
                        ahead = ahead or fetch_next(1)
                        yield frame
                    ahead = ahead or fetch_next(1)
                    continue
                assert ahead is not None
                frames, ahead = await ahead, None
                ahead = fetch_next(i + 1)
                for frame in frames:
                    yield frame
        finally:
            if ahead is not None:
                ahead.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await ahead

    async def _collect(self, sentence: str) -> list[rtc.AudioFrame]:
        return [frame async for frame in self._fetch(sentence)]

    async def _fetch(self, sentence: str) -> AsyncIterator[rtc.AudioFrame]:
        s = self._settings
        url = f"{s.tts_url}/audio/speech"
        body = {
            "model": s.tts_model,
            "input": sentence,
            "voice": s.voice,
            "response_format": s.tts_format,
        }
        try:
            async with self._http.stream(
                "POST", url, json=body, headers=s.headers, timeout=TTS_TIMEOUT
            ) as res:
                if res.status_code >= 400:
                    detail = (await res.aread())[:200].decode(errors="replace")
                    raise SpeechServerError(
                        f"Your speech server refused to speak ({res.status_code}): {detail}"
                    )
                frames: PcmFrames | WavFrames = (
                    PcmFrames(s.tts_rate) if s.tts_format == "pcm" else WavFrames()
                )
                async for chunk in res.aiter_bytes():
                    for frame in frames.feed(chunk):
                        yield frame
                for frame in frames.flush():
                    yield frame
        except httpx.HTTPError as err:
            raise SpeechServerError(
                f"Can't reach your speech server at {s.tts_url} ({type(err).__name__})"
            ) from err
