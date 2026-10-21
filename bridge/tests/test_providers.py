from pathlib import Path

import aiohttp
import httpx
import pytest

from mooz_agent.brain import ToolLoopBrain
from mooz_agent.config import AgentConfig
from mooz_agent.providers import ProviderConfigError, build_providers, check_environment
from mooz_agent.providers.claude import ClaudeModel
from mooz_agent.providers.fakes import OfflineModel
from mooz_agent.providers.grok import GrokModel
from mooz_agent.room import Speaker

pytestmark = pytest.mark.unit

ME = Speaker("a_me", "Atlas", "agent", owner_identity="p_k", owner_name="Kainoa")


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("MOOZ_HOME", str(tmp_path))
    return tmp_path


async def test_offline_mode_uses_the_real_tools_and_memory(
    home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MOOZ_PROVIDERS", "fake")
    async with aiohttp.ClientSession() as http:
        _, _, brain = build_providers(http=http, me=ME, config=AgentConfig(name="Atlas"))
    assert isinstance(brain, ToolLoopBrain)
    assert isinstance(brain.model, OfflineModel)
    assert brain.owner_identity == "p_k" and brain.owner_name == "Kainoa"
    assert brain.memory is not None and brain.toolbox is not None
    assert brain.memory.path == home / "agents" / "atlas" / "memory.jsonl"


@pytest.mark.parametrize(("which", "model_type"), [("claude", ClaudeModel), ("grok", GrokModel)])
async def test_the_configured_brain_is_used(
    home: Path, monkeypatch: pytest.MonkeyPatch, which: str, model_type: type
) -> None:
    monkeypatch.delenv("MOOZ_PROVIDERS", raising=False)
    for key in ("ANTHROPIC_API_KEY", "XAI_API_KEY", "ELEVEN_API_KEY"):
        monkeypatch.setenv(key, "test-key")
    async with aiohttp.ClientSession() as http:
        config = AgentConfig(name="Atlas", brain=which)  # type: ignore[arg-type]
        _, _, brain = build_providers(http=http, me=ME, config=config)
    assert isinstance(brain, ToolLoopBrain) and isinstance(brain.model, model_type)
    assert brain.toolbox is not None and brain.toolbox.config is config


async def test_grok_with_web_search_on_is_warned_about(
    home: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("MOOZ_PROVIDERS", "fake")
    async with aiohttp.ClientSession() as http:
        build_providers(http=http, me=ME, config=AgentConfig(name="Nova", brain="grok"))
        assert "opens web pages" not in caplog.text  # off by default: nothing to warn about
        on = AgentConfig(name="Nova", brain="grok", web_search=True)
        build_providers(http=http, me=ME, config=on)
    assert "opens web pages" in caplog.text


async def test_github_and_web_search_come_from_the_agents_settings(
    home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MOOZ_PROVIDERS", "fake")
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_" + "t" * 36)
    plain = AgentConfig(name="Atlas")
    with_github = AgentConfig(name="Atlas", web_search=False)
    with_github.add_github("kainoa00/mooz")
    async with aiohttp.ClientSession() as http:
        _, _, a = build_providers(http=http, me=ME, config=plain)
        _, _, b = build_providers(http=http, me=ME, config=with_github)
    assert isinstance(a, ToolLoopBrain) and isinstance(b, ToolLoopBrain)
    assert a.toolbox is not None and a.toolbox.github is None and a.web_search is True  # Claude
    assert b.toolbox is not None and b.toolbox.github is not None and b.web_search is False


async def test_local_voice_needs_no_elevenlabs_key(
    home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from mooz_agent.providers.local import LocalSTT, LocalTTS

    monkeypatch.delenv("MOOZ_PROVIDERS", raising=False)
    monkeypatch.delenv("ELEVEN_API_KEY", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("MOOZ_VOICE", "local")
    async with aiohttp.ClientSession() as http, httpx.AsyncClient() as speech:
        stt, tts, brain = build_providers(
            http=http, me=ME, config=AgentConfig(name="Atlas"), speech_http=speech
        )
    assert isinstance(stt, LocalSTT) and isinstance(tts, LocalTTS)
    assert isinstance(brain, ToolLoopBrain) and isinstance(brain.model, ClaudeModel)


async def test_the_agents_own_setting_wins_over_the_environment(
    home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from mooz_agent.providers.local import LocalSTT

    monkeypatch.delenv("MOOZ_PROVIDERS", raising=False)
    monkeypatch.setenv("MOOZ_VOICE", "elevenlabs")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.delenv("ELEVEN_API_KEY", raising=False)
    config = AgentConfig(name="Atlas", voice_provider="local")
    async with aiohttp.ClientSession() as http, httpx.AsyncClient() as speech:
        stt, _, _ = build_providers(http=http, me=ME, config=config, speech_http=speech)
    assert isinstance(stt, LocalSTT)


async def test_an_offline_brain_with_real_voice_needs_no_keys_at_all(
    home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("MOOZ_PROVIDERS", raising=False)
    monkeypatch.setenv("MOOZ_VOICE", "local")
    monkeypatch.setenv("MOOZ_BRAIN", "offline")
    for key in ("ANTHROPIC_API_KEY", "XAI_API_KEY", "ELEVEN_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    async with aiohttp.ClientSession() as http, httpx.AsyncClient() as speech:
        _, _, brain = build_providers(
            http=http, me=ME, config=AgentConfig(name="Atlas"), speech_http=speech
        )
    assert isinstance(brain, ToolLoopBrain) and isinstance(brain.model, OfflineModel)


def test_says_which_keys_are_missing_for_the_chosen_parts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MOOZ_PROVIDERS", raising=False)
    monkeypatch.delenv("MOOZ_BRAIN", raising=False)
    for key in ("ANTHROPIC_API_KEY", "ELEVEN_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(ProviderConfigError, match="Set ANTHROPIC_API_KEY and ELEVEN_API_KEY"):
        check_environment("claude", "elevenlabs")
    with pytest.raises(ProviderConfigError, match=r"Set ANTHROPIC_API_KEY in"):
        check_environment("claude", "local")


def test_a_bad_voice_choice_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    from mooz_agent.providers import voice_provider

    monkeypatch.setenv("MOOZ_VOICE", "piper")
    with pytest.raises(ProviderConfigError, match="elevenlabs or local"):
        voice_provider(AgentConfig(name="Atlas"))


def test_a_key_for_a_remote_http_server_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    from mooz_agent.providers import local_speech

    monkeypatch.setenv("MOOZ_SPEECH_URL", "http://10.0.0.9:3900/v1")
    monkeypatch.setenv("MOOZ_SPEECH_API_KEY", "sk")
    with pytest.raises(ProviderConfigError, match="https"):
        local_speech(AgentConfig(name="Atlas"))
    monkeypatch.setenv("MOOZ_TTS_FORMAT", "ogg")
    with pytest.raises(ProviderConfigError, match="pcm or wav"):
        local_speech(AgentConfig(name="Atlas"))
