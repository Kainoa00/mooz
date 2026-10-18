"""Choose real or fake providers from the environment (keys stay on this machine)."""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

import aiohttp

from ..config import AgentConfig
from ..room import Speaker
from .base import Brain, SpeechToText, TextToSpeech

if TYPE_CHECKING:
    from ..brain import Model, ToolLoopBrain


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


def _model(config: AgentConfig) -> Model:
    if config.brain == "grok":
        from .grok import DEFAULT_GROK_MODEL, GrokModel

        return GrokModel(
            model=config.model or os.environ.get("MOOZ_GROK_MODEL") or DEFAULT_GROK_MODEL
        )
    from .claude import DEFAULT_MODEL, ClaudeModel

    return ClaudeModel(model=config.model or os.environ.get("MOOZ_CLAUDE_MODEL") or DEFAULT_MODEL)


def build_brain(model: Model, me: Speaker, config: AgentConfig) -> ToolLoopBrain:
    """The tool loop with this agent's sources and memory, owned by whoever the room says."""
    from ..brain import ToolLoopBrain
    from ..memory import MemoryStore
    from ..tools.github import GitHub
    from ..tools.toolbox import ToolBox

    owner_name = me.owner_name or "your owner"
    memory = MemoryStore(config.memory_path)
    # A token is optional for public repos; private ones need GITHUB_TOKEN (read-only is best).
    github = GitHub(os.environ.get("GITHUB_TOKEN") or None) if config.github else None
    return ToolLoopBrain(
        model=model,
        agent_name=me.name,
        owner_name=owner_name,
        owner_identity=me.owner_identity,
        toolbox=ToolBox(config, memory, owner_name=owner_name, github=github),
        memory=memory,
        web_search=config.searches_web,
    )


def build_providers(
    *, http: aiohttp.ClientSession, me: Speaker, config: AgentConfig
) -> tuple[SpeechToText, TextToSpeech, Brain]:
    if os.environ.get("MOOZ_PROVIDERS") == "fake":
        from .fakes import FakeSTT, FakeTTS, OfflineModel

        return FakeSTT({}), FakeTTS(), build_brain(OfflineModel(), me, config)

    from .elevenlabs import ElevenLabsSTT, ElevenLabsTTS

    check_environment(config.brain)
    eleven_key = os.environ["ELEVEN_API_KEY"]
    stt = ElevenLabsSTT(api_key=eleven_key, http=http, keyterms=[me.name], language=config.language)
    voice = config.voice_id or os.environ.get("MOOZ_VOICE_ID")
    tts = ElevenLabsTTS(api_key=eleven_key, voice_id=voice, http=http)
    return stt, tts, build_brain(_model(config), me, config)
