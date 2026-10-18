"""The offline model maps a few phrases to real tool calls, so demos and E2E use real tools."""

import pytest

from mooz_agent.brain import MEMORY_HEADING, ToolCall
from mooz_agent.providers.fakes import OfflineModel
from mooz_agent.tools.toolbox import ToolResult, ToolSpec

pytestmark = pytest.mark.unit

READ = ToolSpec(
    "read_file",
    "",
    {"type": "object", "properties": {"source": {"type": "string", "enum": ["site", "plans"]}}},
)


def asked(question: str) -> str:
    return f"<transcript>\n</transcript>\n\nKai (your owner) just asked you: {question}"


@pytest.mark.parametrize(
    ("question", "name", "args"),
    [
        ("read docs/a.md from plans", "read_file", {"source": "plans", "path": "docs/a.md"}),
        ("Read a.md.", "read_file", {"source": "site", "path": "a.md"}),
        ("search for launch date", "search", {"query": "launch date"}),
        ("search for launch in plans", "search", {"query": "launch", "source": "plans"}),
        ("remember that we ship Friday", "remember", {"note": "we ship Friday", "public": False}),
        ("remember publicly that we ship", "remember", {"note": "we ship", "public": True}),
        ("forget m_1234abcd", "forget", {"id": "m_1234abcd"}),
        ("what do you remember about the launch?", "recall", {"query": "the launch"}),
    ],
)
async def test_phrases_become_tool_calls(question: str, name: str, args: dict[str, object]) -> None:
    turn = await OfflineModel().conversation(system="", tools=[READ]).send(asked(question))
    assert turn.answer is None
    [call] = turn.calls
    assert (call.name, call.args) == (name, args)


async def test_anything_else_is_echoed() -> None:
    turn = await OfflineModel().conversation(system="", tools=[]).send(asked("what is 2+2?"))
    assert turn.calls == () and turn.answer is not None
    assert turn.answer.spoken == "You asked: what is 2+2?"


async def test_without_a_source_or_tool_it_says_so() -> None:
    turn = await OfflineModel().conversation(system="", tools=[]).send(asked("read a.md"))
    assert turn.answer is not None and "no files" in turn.answer.spoken


async def test_answers_from_tool_results() -> None:
    conversation = OfflineModel().conversation(system="", tools=[READ])
    await conversation.send(asked("read a.md from site"))
    call = ToolCall("c1", "read_file", {"source": "site", "path": "a.md"})
    ok = await conversation.send_results([(call, ToolResult("a.md (lines 1-1 of 1)\n   1  hi"))])
    assert ok.answer is not None and "hi" in ok.answer.details

    denied = await conversation.send_results([(call, ToolResult("No source called 'x'", True))])
    assert denied.answer is not None and "No source called 'x'" in denied.answer.spoken


async def test_memory_and_sources_come_from_the_system_prompt() -> None:
    system = (
        "You are Atlas.\n\nFolders and repositories you can read for this person: site.\n\n"
        f"{MEMORY_HEADING}- [m_1] the office is in Honolulu\n\nNotes from past meetings…"
    )
    conversation = OfflineModel().conversation(system=system, tools=[])
    remembered = await conversation.send(asked("what do you remember?"))
    assert remembered.answer is not None and "Honolulu" in remembered.answer.details
    sources = await conversation.send(asked("what can you read?"))
    assert sources.answer is not None and "site" in sources.answer.spoken

    empty = OfflineModel().conversation(system="You are Atlas.", tools=[])
    nothing = await empty.send(asked("what do you remember?"))
    assert nothing.answer is not None and "don't remember anything" in nothing.answer.spoken


async def test_offline_summaries_keep_every_line_they_were_given() -> None:
    conversation = OfflineModel().conversation(
        system="You are Atlas, keeping meeting notes.", tools=[]
    )
    turn = await conversation.send(
        "<transcript>\nKai: ship Friday\nLee: ok\n</transcript>\n\nWrite."
    )
    assert turn.answer is not None and turn.answer.details == "Kai: ship Friday\nLee: ok"


async def test_offline_research_searches_and_reports(monkeypatch: pytest.MonkeyPatch) -> None:
    from mooz_agent.brain import REPORT_TOOL, research_prompt
    from mooz_agent.providers import fakes

    search = ToolSpec(
        "search",
        "",
        {"type": "object", "properties": {"source": {"type": "string", "enum": ["plans"]}}},
    )
    conversation = OfflineModel().conversation(
        system=research_prompt("Atlas", "Kai"), tools=[search, REPORT_TOOL], mode="research"
    )
    first = await conversation.send("Task from Kai: Look into the launch date")
    [call] = first.calls
    assert (call.name, call.args) == ("search", {"query": "launch"})

    done = await conversation.send_results([(call, ToolResult("[plans] launch.md:1: March 30th"))])
    [report] = done.calls
    assert report.name == "report_findings" and "March 30th" in str(report.args["details"])

    monkeypatch.setattr(fakes, "SLOW_SECONDS", 0.01)
    slow = OfflineModel().conversation(
        system=research_prompt("Atlas", "Kai"), tools=[REPORT_TOOL], mode="research"
    )
    nothing = await slow.send("Task from Kai: Look into the launch slowly")
    assert nothing.calls[0].name == "report_findings"
    assert "couldn't find" in str(nothing.calls[0].args["spoken"])
