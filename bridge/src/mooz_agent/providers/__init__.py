"""Choose real or fake providers from the environment (keys stay on this machine)."""

from __future__ import annotations

import os

import aiohttp

from ..config import AgentConfig
from ..room import Speaker
from .base import Brain, SpeechToText, TextToSpeech


class ProviderConfigError(Exception):
    """A required key or setting is missing."""


BRAIN_KEYS = {"claude": "ANTHROPIC_API_KEY", "grok": "XAI_API_KEY"}


def check_environment(brain: str = "claude") -> None:
    """Fail before joining a meeting rather than after, if keys are missing."""
    if os.environ.get("MOOZ_PROVIDERS") == "fake":
        return
    needed = (BRAIN_KEYS.get(brain, "ANTHROPIC_API_KEY"), "ELEVEN_API_KEY")
    missing = [k for k in needed if not os.environ.get(k)]
    if missing:
        raise ProviderConfigError(
            f"Set {' and '.join(missing)} in your environment or bridge/.env "
            "(or MOOZ_PROVIDERS=fake for an offline demo)."
        )


def build_providers(
    *, http: aiohttp.ClientSession, me: Speaker, config: AgentConfig
) -> tuple[SpeechToText, TextToSpeech, Brain]:
    if os.environ.get("MOOZ_PROVIDERS") == "fake":
        from .fakes import EchoBrain, FakeSTT, FakeTTS

        return FakeSTT({}), FakeTTS(), EchoBrain()

    from ..brain import ToolLoopBrain
    from .claude import DEFAULT_MODEL, ClaudeModel
    from .elevenlabs import ElevenLabsSTT, ElevenLabsTTS

    check_environment(config.brain)
    eleven_key = os.environ["ELEVEN_API_KEY"]
    stt = ElevenLabsSTT(api_key=eleven_key, http=http, keyterms=[me.name], language=config.language)
    voice = config.voice_id or os.environ.get("MOOZ_VOICE_ID")
    tts = ElevenLabsTTS(api_key=eleven_key, voice_id=voice, http=http)
    brain = ToolLoopBrain(
        model=ClaudeModel(
            model=config.model or os.environ.get("MOOZ_CLAUDE_MODEL") or DEFAULT_MODEL
        ),
        agent_name=me.name,
        owner_name=me.owner_name or "your owner",
        owner_identity=me.owner_identity,
    )
    return stt, tts, brain
