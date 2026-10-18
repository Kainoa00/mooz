import pytest

from mooz_agent.room import Speaker
from mooz_agent.transcript import TranscriptBuffer, Utterance

pytestmark = pytest.mark.unit

ZACH = Speaker("p_z", "Zach", "human")
KAI = Speaker("p_k", "Kainoa", "human")
ATLAS = Speaker("a_1", "Atlas", "agent", owner_identity="p_k")


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_keeps_utterances_in_order() -> None:
    clock = Clock()
    buf = TranscriptBuffer(window_seconds=60, clock=clock)
    buf.add(Utterance(ZACH, "hi", clock.now, "voice"))
    clock.now += 1
    buf.add(Utterance(KAI, "hey", clock.now, "chat"))

    assert [u.text for u in buf.recent()] == ["hi", "hey"]


def test_forgets_utterances_older_than_the_window() -> None:
    clock = Clock()
    buf = TranscriptBuffer(window_seconds=60, clock=clock)
    buf.add(Utterance(ZACH, "old", clock.now, "voice"))
    clock.now += 61
    buf.add(Utterance(KAI, "new", clock.now, "voice"))

    assert [u.text for u in buf.recent()] == ["new"]


def test_render_labels_speakers_and_agents_for_the_model() -> None:
    clock = Clock()
    buf = TranscriptBuffer(window_seconds=60, clock=clock)
    buf.add(Utterance(ZACH, "what's blocking the deploy?", clock.now, "voice"))
    buf.add(Utterance(ATLAS, "The migration.", clock.now, "chat"))
    buf.add(Utterance(KAI, "@Atlas thanks", clock.now, "chat"))

    assert buf.render() == (
        "Zach: what's blocking the deploy?\n"
        "Atlas (agent): The migration.\n"
        "Kainoa (chat): @Atlas thanks"
    )


def test_render_caps_length_by_dropping_the_oldest_lines() -> None:
    clock = Clock()
    buf = TranscriptBuffer(window_seconds=60, clock=clock)
    for i in range(50):
        buf.add(Utterance(ZACH, f"line {i:02d}", clock.now, "voice"))

    rendered = buf.render(max_chars=40)

    assert rendered.endswith("Zach: line 49")
    assert "line 00" not in rendered
    assert len(rendered) <= 40
