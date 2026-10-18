"""Name detection corpus. Every case documents a behavior; xfails are known limitations."""

import pytest

from mooz_agent.addressing import AddressDetector, phonetic_key

pytestmark = pytest.mark.unit

ATLAS = AddressDetector("Atlas")
GROK = AddressDetector("Zach's Grok")

# (utterance, expected question, or None when the agent is NOT being addressed)
VOICE_CASES: list[tuple[str, str | None]] = [
    # Addressed at the start
    ("Atlas, what's blocking the deploy?", "what's blocking the deploy?"),
    ("atlas what's blocking the deploy", "what's blocking the deploy"),
    ("Hey Atlas, can you check CI?", "can you check CI?"),
    ("hey atlas can you check ci", "can you check ci"),
    ("OK Atlas, summarize that.", "summarize that."),
    ("Okay, Atlas. What did we decide?", "What did we decide?"),
    ("So Atlas, any ideas?", "any ideas?"),
    ("Um, Atlas, where is the config?", "where is the config?"),
    ("Yo Atlas what's up with the tests", "what's up with the tests"),
    ("And Atlas, one more thing: the auth bug?", "one more thing: the auth bug?"),
    # Speech-to-text misspellings of the name
    ("Hey Atlis, what's the status?", "what's the status?"),
    ("Hey Atlus what's the status", "what's the status"),
    ("Atles, are you there?", "are you there?"),
    ("Hey Atlass, check main", "check main"),
    # Addressed at the end of a question
    ("What do you think, Atlas?", "What do you think"),
    ("Can you look into the failing build Atlas?", "Can you look into the failing build"),
    ("Is the migration done, atlas", "Is the migration done"),
    # Wake word alone: addressed with no question yet
    ("Hey Atlas.", ""),
    ("Atlas?", ""),
    ("Atlas", ""),
    # Mentioned, not addressed
    ("I asked Atlas about it yesterday.", None),
    ("Atlas said the build was green.", None),
    ("atlas told me to restart it", None),
    ("Atlas was wrong about that.", None),
    ("Atlas's answer was useful", None),
    ("We should ask atlas later", None),
    ("The Atlas project is behind schedule", None),
    ("I think Atlas has the context on this", None),
    ("Zach, what do you think?", None),
    ("Hey Zach, can you share your screen?", None),
    ("Let's look at the atlas of the codebase", None),
    ("What's blocking the deploy?", None),
    ("", None),
    # Words that merely sound a bit like the name
    ("Hey, at last we shipped it!", None),
    ("Outlast the competition, that's the plan", None),
    ("Hey Alice, can you check?", None),
    ("Hello Atlanta team", None),
]


@pytest.mark.parametrize(("utterance", "question"), VOICE_CASES)
def test_voice_addressing(utterance: str, question: str | None) -> None:
    result = ATLAS.check(utterance, via="voice")
    if question is None:
        assert result is None
    else:
        assert result is not None
        assert result.question == question


CHAT_CASES: list[tuple[str, str | None]] = [
    ("@Atlas what's blocking the deploy?", "what's blocking the deploy?"),
    ("@atlas can you check ci", "can you check ci"),
    ("what's blocking the deploy @Atlas", "what's blocking the deploy"),
    ("@Atlas", ""),
    ("Atlas, can you check CI?", "can you check CI?"),
    ("thanks @Grok", None),
    ("I asked Atlas yesterday", None),
    ("email me at atlas@example.com", None),
]


@pytest.mark.parametrize(("message", "question"), CHAT_CASES)
def test_chat_addressing(message: str, question: str | None) -> None:
    result = ATLAS.check(message, via="chat")
    if question is None:
        assert result is None
    else:
        assert result is not None
        assert result.question == question


def test_everyone_addresses_all_agents() -> None:
    assert ATLAS.check("@everyone what are the blockers?", via="chat") is not None
    assert ATLAS.check("@agents any blockers?", via="chat") is not None
    assert ATLAS.check("Hey agents, any blockers?", via="voice") is not None
    assert ATLAS.check("everyone has the notes", via="voice") is None
    assert ATLAS.check("Agents can't see my screen yet", via="voice") is None
    assert ATLAS.check("@all I'm sharing my screen", via="chat") is None


# Code review: a vowel-free phonetic key alone let everyday words wake agents.
@pytest.mark.parametrize(
    ("name", "utterance"),
    [
        ("Claude", "Could we move this to Friday?"),
        ("Claude", "Okay could you share your screen"),
        ("Claude", "Cloud costs went up"),
        ("Max", "Makes sense?"),
        ("Juno", "Join the other call first."),
    ],
)
def test_common_words_do_not_wake_agents_with_similar_names(name: str, utterance: str) -> None:
    assert AddressDetector(name).check(utterance, via="voice") is None


@pytest.mark.parametrize(
    ("name", "utterance"),
    [
        ("Claude", "Hey Claud, what's next?"),
        ("Grok", "Hey Grock, what's next?"),
        ("Grok", "groc what's next"),
    ],
)
def test_real_mis_transcriptions_still_wake(name: str, utterance: str) -> None:
    assert AddressDetector(name).check(utterance, via="voice") is not None


def test_a_name_closing_a_command_after_a_comma_wakes() -> None:
    result = ATLAS.check("Summarize the last ten minutes, Atlas.", via="voice")
    assert result is not None
    assert result.question == "Summarize the last ten minutes"


@pytest.mark.parametrize(
    ("utterance", "question"),
    [
        ("Zach's Grok, what's my schedule?", "what's my schedule?"),
        ("Hey Grok, what's my schedule?", "what's my schedule?"),
        ("@Grok what's my schedule", "what's my schedule"),
        ("@Zach's Grok what's my schedule", "what's my schedule"),
        ("@Zach\u2019s Grok what's my schedule", "what's my schedule"),
        ("Grok said no", None),
    ],
)
def test_multi_word_names_wake_on_the_full_name_or_its_last_word(
    utterance: str, question: str | None
) -> None:
    via = "chat" if utterance.startswith("@") else "voice"
    result = GROK.check(utterance, via=via)
    assert (result.question if result else None) == question


@pytest.mark.xfail(strict=True, reason="known limitation: vocative in the middle of a sentence")
def test_mid_sentence_vocative() -> None:
    assert ATLAS.check("So what I want to know, Atlas, is why CI fails", via="voice") is not None


def test_phonetic_key_groups_spellings_that_sound_alike() -> None:
    assert phonetic_key("Atlas") == phonetic_key("Atlis") == phonetic_key("Atlus")
    assert phonetic_key("Atlas") != phonetic_key("Alice")


def test_corpus_size_meets_the_plan() -> None:
    assert len(VOICE_CASES) + len(CHAT_CASES) >= 40
