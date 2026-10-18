import json
from dataclasses import dataclass, field
from typing import Any

import httpx
import openai
import pytest

from mooz_agent.brain import ToolCall
from mooz_agent.providers.base import Answer, BrainError
from mooz_agent.providers.grok import DEFAULT_GROK_MODEL, XAI_BASE_URL, GrokModel
from mooz_agent.tools.toolbox import ToolResult, ToolSpec

pytestmark = pytest.mark.unit

READ = ToolSpec(
    "read_file",
    "Read a file",
    {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
        "additionalProperties": False,
    },
)


@dataclass
class Content:
    type: str
    text: str = ""
    refusal: str = ""


@dataclass
class Item:
    type: str
    content: list[Content] = field(default_factory=list)
    call_id: str = ""
    name: str = ""
    arguments: str = ""


@dataclass
class Resp:
    id: str
    output: list[Item]
    status: str = "completed"


def message(spoken: str, details: str = "") -> Resp:
    text = json.dumps({"spoken": spoken, "details": details})
    return Resp(
        "resp_final",
        [Item("reasoning"), Item("message", content=[Content("output_text", text=text)])],
    )


class FakeClient:
    def __init__(self, *responses: Resp | Exception) -> None:
        self.responses_q = list(responses)
        self.calls: list[dict[str, Any]] = []
        self.responses = self

    async def create(self, **kwargs: Any) -> Resp:
        self.calls.append(kwargs)
        r = self.responses_q.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


async def test_request_shape() -> None:
    client = FakeClient(message("Hi."))
    conv = GrokModel(client=client).conversation(system="SYS", tools=[READ])

    turn = await conv.send("hello")

    assert turn.answer == Answer("Hi.")
    call = client.calls[0]
    assert call["model"] == DEFAULT_GROK_MODEL == "grok-4.7"
    assert call["instructions"] == "SYS"
    assert call["input"] == [{"role": "user", "content": "hello"}]
    assert call["tools"] == [
        {
            "type": "function",
            "name": "read_file",
            "description": "Read a file",
            "parameters": READ.parameters,
            "strict": True,
        }
    ]
    fmt = call["text"]["format"]
    assert (
        fmt["type"] == "json_schema"
        and fmt["strict"] is True
        and fmt["schema"]["required"] == ["spoken", "details"]
    )
    assert "previous_response_id" not in call


async def test_function_call_round_trip_chains_responses() -> None:
    first = Resp(
        "resp_1",
        [Item("function_call", call_id="call_1", name="read_file", arguments='{"path": "a.md"}')],
    )
    client = FakeClient(first, message("Done."))
    conv = GrokModel(client=client).conversation(system="SYS", tools=[READ])

    turn = await conv.send("read a.md")
    assert turn.calls == (ToolCall("call_1", "read_file", {"path": "a.md"}),)

    second = await conv.send_results(
        [
            (turn.calls[0], ToolResult("contents")),
        ]
    )

    assert second.answer == Answer("Done.")
    call = client.calls[1]
    assert call["previous_response_id"] == "resp_1"
    assert call["instructions"] == "SYS"
    assert call["input"] == [
        {"type": "function_call_output", "call_id": "call_1", "output": "contents"}
    ]


async def test_tool_errors_are_marked_for_the_model() -> None:
    first = Resp("resp_1", [Item("function_call", call_id="c", name="read_file", arguments="{}")])
    client = FakeClient(first, message("ok"))
    conv = GrokModel(client=client).conversation(system="S", tools=[READ])
    turn = await conv.send("x")

    await conv.send_results([(turn.calls[0], ToolResult("No source called 'x'", is_error=True))])

    assert client.calls[1]["input"][0]["output"] == "Error: No source called 'x'"


async def test_bad_function_arguments_become_empty_args() -> None:
    client = FakeClient(
        Resp("r", [Item("function_call", call_id="c", name="read_file", arguments="{not json")])
    )

    turn = await GrokModel(client=client).conversation(system="S", tools=[READ]).send("x")

    assert turn.calls == (ToolCall("c", "read_file", {}),)


async def test_refusal() -> None:
    client = FakeClient(Resp("r", [Item("message", content=[Content("refusal", refusal="no")])]))

    turn = await GrokModel(client=client).conversation(system="S", tools=[]).send("x")

    assert turn.refused


@pytest.mark.parametrize(
    "resp",
    [
        Resp(
            "r",
            [Item("message", content=[Content("output_text", text='{"spoken": "cut')])],
            status="incomplete",
        ),
        Resp("r", [Item("message", content=[Content("output_text", text="plain words")])]),
    ],
)
async def test_truncated_or_malformed_answers_are_errors(resp: Resp) -> None:
    with pytest.raises(BrainError):
        await GrokModel(client=FakeClient(resp)).conversation(system="S", tools=[]).send("x")


async def test_api_failures_raise_brain_error() -> None:
    request = httpx.Request("POST", f"{XAI_BASE_URL}/responses")
    client = FakeClient(openai.APIConnectionError(request=request))

    with pytest.raises(BrainError):
        await GrokModel(client=client).conversation(system="S", tools=[]).send("x")


async def test_no_tools_means_no_tools_param_and_model_is_configurable() -> None:
    client = FakeClient(message("ok"))

    await GrokModel(client=client, model="grok-4.6").conversation(system="S", tools=[]).send("x")

    assert "tools" not in client.calls[0]
    assert client.calls[0]["model"] == "grok-4.6"


async def test_optional_tool_arguments_become_required_but_nullable() -> None:
    from mooz_agent.tools.toolbox import ToolSpec

    spec = ToolSpec(
        "search",
        "Search",
        {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "source": {"type": "string", "enum": ["a", "b"]},
                "regex": {"type": "boolean"},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    )
    client = FakeClient(message("Hi."))
    await GrokModel(client=client).conversation(system="S", tools=[spec]).send("x")
    params = client.calls[0]["tools"][0]["parameters"]
    assert params["required"] == ["query", "source", "regex"]
    assert params["properties"]["query"] == {"type": "string"}
    assert params["properties"]["source"] == {"type": ["string", "null"], "enum": ["a", "b", None]}
    assert params["properties"]["regex"] == {"type": ["boolean", "null"]}
    assert spec.parameters["required"] == ["query"]  # the shared spec is untouched


# -- research mode ---------------------------------------------------------------------


@dataclass
class Action:
    type: str = "search"
    query: str = ""


@dataclass
class SearchItem:
    type: str
    action: Action | None = None


async def test_research_mode_drops_the_answer_format_and_adds_web_search() -> None:
    report = Item(
        "function_call", call_id="r", name="report_findings", arguments='{"spoken": "Ok."}'
    )
    client = FakeClient(
        Resp("resp_1", [SearchItem("web_search_call", Action(query="ci flake")), report])
    )  # type: ignore[list-item]
    conv = GrokModel(client=client).conversation(
        system="S", tools=[READ], mode="research", web_search=True
    )

    turn = await conv.send("x")

    call = client.calls[0]
    assert "text" not in call
    assert call["tools"][-1] == {"type": "web_search"}
    assert call["timeout"] >= 60
    assert turn.searches == ("ci flake",)
    assert turn.calls == (ToolCall("r", "report_findings", {"spoken": "Ok."}),)


async def test_if_xai_rejects_web_search_with_functions_it_carries_on_without() -> None:
    rejected = openai.BadRequestError(
        "web_search can't be combined with function tools",
        response=httpx.Response(400, request=httpx.Request("POST", XAI_BASE_URL)),
        body=None,
    )
    plain = Resp("resp_2", [Item("message", content=[Content("output_text", text="Found it.")])])
    client = FakeClient(rejected, plain, plain)
    conv = GrokModel(client=client).conversation(
        system="S", tools=[READ], mode="research", web_search=True
    )

    turn = await conv.send("x")
    await conv.send("again")

    assert turn.answer is not None and turn.answer.details == "Found it."
    assert turn.notices and "carrying on without it" in turn.notices[0]  # said in progress
    assert {"type": "web_search"} in client.calls[0]["tools"]
    assert {"type": "web_search"} not in client.calls[1]["tools"]
    assert {"type": "web_search"} not in client.calls[2]["tools"]


async def test_web_search_stops_once_a_task_has_used_its_searches() -> None:
    read = Item("function_call", call_id="c", name="read_file", arguments='{"path": "a.md"}')

    def searched(*queries: str) -> Resp:
        items = [SearchItem("web_search_call", Action(query=q)) for q in queries]
        return Resp("resp", [*items, read])  # type: ignore[list-item]

    client = FakeClient(searched("a", "b", "c"), searched("d", "e"), searched())
    conv = GrokModel(client=client).conversation(
        system="S", tools=[READ], mode="research", web_search=True
    )
    turn = await conv.send("x")
    for _ in range(2):
        turn = await conv.send_results([(turn.calls[0], ToolResult("ok"))])

    assert {"type": "web_search"} in client.calls[1]["tools"]
    assert {"type": "web_search"} not in client.calls[2]["tools"]


async def test_a_400_in_answer_mode_is_still_an_error() -> None:
    rejected = openai.BadRequestError(
        "bad", response=httpx.Response(400, request=httpx.Request("POST", XAI_BASE_URL)), body=None
    )
    conv = GrokModel(client=FakeClient(rejected)).conversation(system="S", tools=[READ])
    with pytest.raises(BrainError):
        await conv.send("x")
