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
