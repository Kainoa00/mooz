"""Choose real or fake providers from the environment (keys stay on this machine)."""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING

import aiohttp
import httpx

from ..config import VOICE_PROVIDERS, AgentConfig
from ..room import Speaker
from .base import Brain, SpeechToText, TextToSpeech

log = logging.getLogger(__name__)

if TYPE_CHECKING:
    from ..brain import Model, ToolLoopBrain
    from .local import LocalSpeech


class ProviderConfigError(Exception):
    """A required key or setting is missing."""


BRAIN_KEYS = {"claude": "ANTHROPIC_API_KEY", "grok": "XAI_API_KEY"}


def voice_provider(config: AgentConfig) -> str:
    """The agent's own setting, else MOOZ_VOICE, else ElevenLabs."""
    choice = config.voice_provider or os.environ.get("MOOZ_VOICE") or "elevenlabs"
    if choice not in VOICE_PROVIDERS:
        raise ProviderConfigError(f"MOOZ_VOICE is elevenlabs or local, not {choice!r}")
    return choice


def offline_brain() -> bool:
    """MOOZ_BRAIN=offline: the scripted brain with real voice (no AI key at all)."""
    return os.environ.get("MOOZ_BRAIN") == "offline"


def check_environment(brain: str = "claude", voice: str = "elevenlabs") -> None:
    """Fail before joining a meeting rather than after, if keys are missing."""
    if os.environ.get("MOOZ_PROVIDERS") == "fake":
        return
    needed = [] if offline_brain() else [BRAIN_KEYS.get(brain, "ANTHROPIC_API_KEY")]
    if voice == "elevenlabs":
        needed.append("ELEVEN_API_KEY")
    missing = [k for k in needed if not os.environ.get(k)]
    if missing:
        raise ProviderConfigError(
            f"Set {' and '.join(missing)} in ~/.mooz/.env or your environment (or MOOZ_VOICE=local "
            "for a speech server on your machine, or MOOZ_PROVIDERS=fake for an offline demo)."
        )


def local_speech(config: AgentConfig) -> LocalSpeech:
    """The local speech server settings from the environment, checked."""
    from .local import LocalSpeech, SpeechServerError, speech_problem

    try:
        settings = LocalSpeech.from_env(os.environ, voice=config.voice_id, language=config.language)
    except SpeechServerError as err:
        raise ProviderConfigError(str(err)) from err
    problem = speech_problem(settings)
    if problem:
        raise ProviderConfigError(problem)
    return settings


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
    if config.brain == "grok" and config.searches_web:
        log.warning(
            "Web search is on for %s's research tasks. Grok's search also opens web pages, so "
            "a page or issue a task reads could get it to visit an address that carries what "
            "it found. To turn it off: web_search = false in %s",
            config.name,
            config.home / "agent.toml",
        )
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
    *,
    http: aiohttp.ClientSession,
    me: Speaker,
    config: AgentConfig,
    speech_http: httpx.AsyncClient | None = None,
) -> tuple[SpeechToText, TextToSpeech, Brain]:
    """`speech_http` carries a local speech server's requests (it's needed for local voice)."""
    from .fakes import FakeSTT, FakeTTS, OfflineModel

    if os.environ.get("MOOZ_PROVIDERS") == "fake":
        return FakeSTT({}), FakeTTS(), build_brain(OfflineModel(), me, config)

    voice = voice_provider(config)
    check_environment(config.brain, voice)
    stt: SpeechToText
    tts: TextToSpeech
    if voice == "local":
        from .local import LocalSTT, LocalTTS

        if speech_http is None:
            raise ProviderConfigError("local voice needs an HTTP client")
        settings = local_speech(config)
        stt, tts = LocalSTT(settings, speech_http), LocalTTS(settings, speech_http)
    else:
        from .elevenlabs import ElevenLabsSTT, ElevenLabsTTS

        key = os.environ["ELEVEN_API_KEY"]
        stt = ElevenLabsSTT(api_key=key, http=http, keyterms=[me.name], language=config.language)
        voice_id = config.voice_id or os.environ.get("MOOZ_VOICE_ID")
        tts = ElevenLabsTTS(api_key=key, voice_id=voice_id, http=http)
    model = OfflineModel() if offline_brain() else _model(config)
    return stt, tts, build_brain(model, me, config)
