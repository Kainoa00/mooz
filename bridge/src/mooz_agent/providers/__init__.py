"""Choose real or fake providers from the environment (keys stay on this machine)."""

from __future__ import annotations

import os

import aiohttp

from ..room import Speaker
from .base import Brain, SpeechToText, TextToSpeech


class ProviderConfigError(Exception):
    """A required key or setting is missing."""


def check_environment() -> None:
    """Fail before joining a meeting rather than after, if keys are missing."""
    if os.environ.get("MOOZ_PROVIDERS") == "fake":
        return
    missing = [k for k in ("ANTHROPIC_API_KEY", "ELEVEN_API_KEY") if not os.environ.get(k)]
    if missing:
        raise ProviderConfigError(
            f"Set {' and '.join(missing)} in your environment or bridge/.env "
            "(or MOOZ_PROVIDERS=fake for an offline demo)."
        )


def build_providers(
    *, http: aiohttp.ClientSession, me: Speaker
) -> tuple[SpeechToText, TextToSpeech, Brain]:
    if os.environ.get("MOOZ_PROVIDERS") == "fake":
        from .fakes import EchoBrain, FakeSTT, FakeTTS

        return FakeSTT({}), FakeTTS(), EchoBrain()

    from .claude import DEFAULT_MODEL, ClaudeBrain
    from .elevenlabs import ElevenLabsSTT, ElevenLabsTTS

    check_environment()
    eleven_key = os.environ["ELEVEN_API_KEY"]
    stt = ElevenLabsSTT(api_key=eleven_key, http=http, keyterms=[me.name])
    tts = ElevenLabsTTS(api_key=eleven_key, voice_id=os.environ.get("MOOZ_VOICE_ID"), http=http)
    brain = ClaudeBrain(
        agent_name=me.name,
        owner_name=me.owner_name or "your owner",
        owner_identity=me.owner_identity,
        model=os.environ.get("MOOZ_CLAUDE_MODEL") or DEFAULT_MODEL,
    )
    return stt, tts, brain
