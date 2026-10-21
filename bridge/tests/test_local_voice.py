"""Local voice: any OpenAI-compatible speech server (VoiceStudio is the one we document)."""

import asyncio
import json
import logging
import struct
from collections.abc import AsyncIterator

import httpx
import numpy as np
import pytest
import respx
from livekit import rtc

from mooz_agent.providers.local import (
    LocalSpeech,
    LocalSTT,
    LocalTTS,
    PcmFrames,
    SpeechServerError,
    WavFrames,
    check_speech_server,
    speech_problem,
    speech_warning,
)
from mooz_agent.room import Speaker

pytestmark = pytest.mark.unit

URL = "http://127.0.0.1:3900/v1"
ZACH = Speaker("p_z", "Zach", "human")


def frame(level: int, ms: int = 100) -> rtc.AudioFrame:
    samples = 16 * ms
    return rtc.AudioFrame(np.full(samples, level, dtype=np.int16).tobytes(), 16_000, 1, samples)


async def audio(*runs: tuple[str, int]) -> AsyncIterator[rtc.AudioFrame]:
    for level, count in runs:
        for _ in range(count):
            yield frame(3000 if level == "l" else 20)
            await asyncio.sleep(0)


async def heard(stt: LocalSTT, *runs: tuple[str, int]) -> list[str]:
    return [text async for text in stt.transcribe(ZACH, audio(*runs))]


def fields(request: httpx.Request) -> bytes:
    return request.read()


# -- settings ------------------------------------------------------------------------


def test_settings_come_from_the_environment_with_sensible_defaults() -> None:
    plain = LocalSpeech.from_env({})
    assert (plain.stt_url, plain.tts_url) == (URL, URL)
    assert (plain.stt_model, plain.tts_model, plain.voice) == ("whisper-1", "tts-1", "default")
    assert (plain.tts_format, plain.tts_rate, plain.api_key) == ("pcm", 24_000, None)
    custom = LocalSpeech.from_env(
        {
            "MOOZ_SPEECH_URL": "http://localhost:8000/v1/",
            "MOOZ_TTS_URL": "http://127.0.0.1:8880/v1",
            "MOOZ_STT_MODEL": "Systran/faster-whisper-small",
            "MOOZ_TTS_MODEL": "kokoro",
            "MOOZ_TTS_VOICE": "af_bella",
            "MOOZ_TTS_FORMAT": "wav",
            "MOOZ_SPEECH_API_KEY": "sk-local",
            "MOOZ_STT_CONCURRENCY": "1",
        },
        voice="am_adam",
        language="de",
    )
    assert (
        custom.stt_url == "http://localhost:8000/v1"
        and custom.tts_url == "http://127.0.0.1:8880/v1"
    )
    assert custom.voice == "am_adam"  # the agent's own voice wins
    assert (custom.tts_format, custom.api_key, custom.language) == ("wav", "sk-local", "de")
    assert custom.stt_concurrency == 1


@pytest.mark.parametrize(
    "env",
    [{"MOOZ_TTS_FORMAT": "mp3"}, {"MOOZ_TTS_RATE": "fast"}, {"MOOZ_SPEECH_URL": "ftp://x/v1"}],
)
def test_bad_settings_are_refused(env: dict[str, str]) -> None:
    with pytest.raises(SpeechServerError):
        LocalSpeech.from_env(env)


def test_a_key_never_goes_unencrypted_to_another_machine() -> None:
    remote = LocalSpeech.from_env({"MOOZ_SPEECH_URL": "http://10.0.0.5:3900/v1"})
    assert speech_problem(remote) is None
    assert "unencrypted" in (speech_warning(remote) or "")
    keyed = LocalSpeech.from_env(
        {"MOOZ_SPEECH_URL": "http://10.0.0.5:3900/v1", "MOOZ_SPEECH_API_KEY": "sk"}
    )
    assert "https" in (speech_problem(keyed) or "")
    local = LocalSpeech.from_env({"MOOZ_SPEECH_API_KEY": "sk"})
    assert speech_problem(local) is None and speech_warning(local) is None
    tls = LocalSpeech.from_env(
        {"MOOZ_SPEECH_URL": "https://gpu.example/v1", "MOOZ_SPEECH_API_KEY": "sk"}
    )
    assert speech_problem(tls) is None and speech_warning(tls) is None


@respx.mock
async def test_checks_the_server_is_there_before_joining() -> None:
    respx.get(f"{URL}/models").respond(200, json={"data": []})
    async with httpx.AsyncClient() as http:
        await check_speech_server(http, LocalSpeech())
    respx.get(f"{URL}/models").mock(side_effect=httpx.ConnectError("refused"))
    async with httpx.AsyncClient() as http:
        with pytest.raises(SpeechServerError, match="Is it running"):
            await check_speech_server(http, LocalSpeech())


# -- hearing ---------------------------------------------------------------------------


@respx.mock
async def test_transcribes_each_utterance_once_with_the_standard_fields() -> None:
    route = respx.post(f"{URL}/audio/transcriptions").respond(200, json={"text": " Hello there. "})
    async with httpx.AsyncClient() as http:
        stt = LocalSTT(LocalSpeech(language="en"), http)
        assert await heard(stt, ("q", 3), ("l", 5), ("q", 8)) == ["Hello there."]
    assert route.call_count == 1
    request = route.calls.last.request
    body = fields(request)
    for name, value in [("model", b"whisper-1"), ("language", b"en"), ("response_format", b"json")]:
        assert f'name="{name}"'.encode() in body and value in body
    wav = body[body.index(b"RIFF") :]
    assert wav[8:12] == b"WAVE"
    channels, rate = struct.unpack("<HI", wav[22:28])
    assert (channels, rate) == (1, 16_000)
    assert "authorization" not in request.headers


@respx.mock
async def test_sends_the_key_only_when_there_is_one() -> None:
    route = respx.post(f"{URL}/audio/transcriptions").respond(200, json={"text": "hi"})
    async with httpx.AsyncClient() as http:
        await heard(LocalSTT(LocalSpeech(api_key="sk-local"), http), ("l", 5), ("q", 8))
    assert route.calls.last.request.headers["authorization"] == "Bearer sk-local"


@respx.mock
async def test_a_cough_is_not_worth_a_request() -> None:
    route = respx.post(f"{URL}/audio/transcriptions").respond(200, json={"text": "hi"})
    async with httpx.AsyncClient() as http:
        assert await heard(LocalSTT(LocalSpeech(), http), ("l", 2), ("q", 8)) == []
    assert not route.called


@respx.mock
async def test_a_failed_request_is_skipped_and_said_once(caplog: pytest.LogCaptureFixture) -> None:
    respx.post(f"{URL}/audio/transcriptions").mock(
        side_effect=[
            httpx.Response(500, text="boom"),
            httpx.ConnectError("refused"),
            httpx.Response(200, text="not json"),
            httpx.Response(200, json={"text": "back again"}),
        ]
    )
    caplog.set_level(logging.WARNING, logger="mooz_agent.providers.local")
    async with httpx.AsyncClient() as http:
        stt = LocalSTT(LocalSpeech(), http)
        words = await heard(stt, *[("l", 5), ("q", 8)] * 4)
    assert words == ["back again"]
    # One warning per kind of trouble a minute, not one per utterance.
    assert len([r for r in caplog.records if r.levelno == logging.WARNING]) == 3


@respx.mock
async def test_drops_what_whisper_hears_in_silence_but_not_real_speech() -> None:
    respx.post(f"{URL}/audio/transcriptions").respond(200, json={"text": "Thank you."})
    async with httpx.AsyncClient() as http:
        stt = LocalSTT(LocalSpeech(), http)
        assert await heard(stt, ("l", 5), ("q", 8)) == []  # 1.3 s: probably noise
        assert await heard(stt, ("l", 20), ("q", 8)) == ["Thank you."]  # 2.8 s: someone said it


@respx.mock
async def test_only_so_many_requests_at_once_across_speakers() -> None:
    busy = 0
    most = 0

    async def slow(_: httpx.Request) -> httpx.Response:
        nonlocal busy, most
        busy += 1
        most = max(most, busy)
        await asyncio.sleep(0.05)
        busy -= 1
        return httpx.Response(200, json={"text": "hi"})

    respx.post(f"{URL}/audio/transcriptions").mock(side_effect=slow)
    async with httpx.AsyncClient() as http:
        stt = LocalSTT(LocalSpeech(stt_concurrency=1), http)
        results = await asyncio.gather(*(heard(stt, ("l", 5), ("q", 8)) for _ in range(3)))
    assert results == [["hi"]] * 3 and most == 1


# -- speaking --------------------------------------------------------------------------


def test_pcm_chunks_become_frames_whatever_the_byte_boundaries() -> None:
    frames = PcmFrames(24_000)
    samples = np.arange(1000, dtype=np.int16).tobytes()
    out = [
        *frames.feed(samples[:333]),
        *frames.feed(samples[333:1001]),
        *frames.feed(samples[1001:]),
    ]
    out += frames.flush()
    assert all(f.sample_rate == 24_000 and f.num_channels == 1 for f in out)
    joined = np.concatenate([np.frombuffer(bytes(f.data), dtype=np.int16) for f in out])
    assert np.array_equal(joined, np.arange(1000, dtype=np.int16))


def wav_header(rate: int, channels: int) -> bytes:
    fmt = struct.pack("<HHIIHH", 1, channels, rate, rate * channels * 2, channels * 2, 16)
    # A streamed WAV doesn't know its length: sizes are 0xFFFFFFFF.
    return b"RIFF\xff\xff\xff\xffWAVEfmt " + struct.pack("<I", 16) + fmt + b"data\xff\xff\xff\xff"


def test_wav_takes_its_rate_from_the_header_and_comes_down_to_mono() -> None:
    frames = WavFrames()
    stereo = np.array([[100, 300], [-200, 200]] * 400, dtype=np.int16).tobytes()
    body = wav_header(16_000, 2) + stereo
    out = [*frames.feed(body[:20]), *frames.feed(body[20:50]), *frames.feed(body[50:])]
    out += frames.flush()
    assert {f.sample_rate for f in out} == {16_000} and {f.num_channels for f in out} == {1}
    joined = np.concatenate([np.frombuffer(bytes(f.data), dtype=np.int16) for f in out])
    assert list(joined[:4]) == [200, 0, 200, 0]


def test_wav_must_be_16_bit() -> None:
    header = bytearray(wav_header(16_000, 1))
    header[34:36] = struct.pack("<H", 8)
    with pytest.raises(SpeechServerError, match="16-bit"):
        list(WavFrames().feed(bytes(header) + b"\x00" * 100))


def pcm(seconds: float, rate: int = 24_000) -> bytes:
    return np.zeros(int(seconds * rate), dtype=np.int16).tobytes()


@respx.mock
async def test_speaks_one_sentence_per_request_in_order() -> None:
    route = respx.post(f"{URL}/audio/speech").respond(200, content=pcm(0.1))
    async with httpx.AsyncClient() as http:
        tts = LocalTTS(LocalSpeech(), http)
        out = [f async for f in tts.synthesize("The launch is March 30th. Docs are in the plan!")]
    bodies = [json.loads(c.request.read()) for c in route.calls]
    assert [b["input"] for b in bodies] == ["The launch is March 30th.", "Docs are in the plan!"]
    assert all(
        (b["model"], b["voice"], b["response_format"]) == ("tts-1", "default", "pcm")
        for b in bodies
    )
    assert sum(f.samples_per_channel for f in out) == 2 * 2400


@respx.mock
async def test_a_refused_speech_request_says_why() -> None:
    respx.post(f"{URL}/audio/speech").respond(404, json={"detail": "voice not found"})
    async with httpx.AsyncClient() as http:
        with pytest.raises(SpeechServerError, match="404"):
            [f async for f in LocalTTS(LocalSpeech(), http).synthesize("Hello.")]


@respx.mock
async def test_says_its_fixed_phrases_from_memory_once_warmed() -> None:
    route = respx.post(f"{URL}/audio/speech").respond(200, content=pcm(0.1))
    async with httpx.AsyncClient() as http:
        tts = LocalTTS(LocalSpeech(), http)
        await tts.warm(["Yes?"])
        assert route.call_count == 1
        out = [f async for f in tts.synthesize("Yes?")]
    assert route.call_count == 1 and sum(f.samples_per_channel for f in out) == 2400


@respx.mock
async def test_stopping_mid_answer_closes_the_requests() -> None:
    route = respx.post(f"{URL}/audio/speech").respond(200, content=pcm(1.0))
    async with httpx.AsyncClient() as http:
        gen = LocalTTS(LocalSpeech(), http).synthesize(
            "This is the first sentence. Here is a second one. And a third one too."
        )
        first = await gen.__anext__()
        assert first.sample_rate == 24_000
        await gen.aclose()
    assert route.call_count <= 2  # the one playing, and at most the next one fetched early
