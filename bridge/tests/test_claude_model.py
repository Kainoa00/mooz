import json
from dataclasses import dataclass, field
from typing import Any

import anthropic
import httpx
import pytest

from mooz_agent.brain import ToolCall
from mooz_agent.providers.base import Answer, BrainError
from mooz_agent.providers.claude import DEFAULT_MODEL, FALLBACK_BETA, ClaudeModel
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
class Block:
    type: str
    text: str = ""
    id: str = ""
    name: str = ""
    input: dict[str, Any] = field(default_factory=dict)


@dataclass
class Response:
    content: list[Block]
    stop_reason: str = "end_turn"


class FakeClient:
    def __init__(self, *responses: Response | Exception) -> None:
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []
        self.beta = self
        self.messages = self

    async def create(self, **kwargs: Any) -> Response:
        self.calls.append(json.loads(json.dumps(kwargs, default=lambda o: o.__dict__)))
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def final(spoken: str, details: str = "") -> Response:
    return Response(
        [Block("thinking"), Block("text", text=json.dumps({"spoken": spoken, "details": details}))]
    )


async def test_request_shape() -> None:
    client = FakeClient(final("Hi."))
    conv = ClaudeModel(client=client).conversation(system="SYS", tools=[READ])

    turn = await conv.send("hello")

    assert turn.answer == Answer("Hi.")
    call = client.calls[0]
    assert call["model"] == DEFAULT_MODEL
    assert call["system"] == "SYS"
    assert call["messages"] == [{"role": "user", "content": "hello"}]
    assert call["tools"] == [
        {
            "name": "read_file",
            "description": "Read a file",
            "input_schema": READ.parameters,
            "strict": True,
        }
    ]
    assert call["output_config"]["effort"] == "low"
    assert call["output_config"]["format"]["type"] == "json_schema"
    assert call["betas"] == [FALLBACK_BETA] and call["fallbacks"] == "default"


async def test_no_tools_means_no_tools_param() -> None:
    client = FakeClient(final("Hi."))

    await ClaudeModel(client=client).conversation(system="S", tools=[]).send("x")

    assert "tools" not in client.calls[0]


async def test_tool_round_trip_passes_content_back_unchanged() -> None:
    use = Block("tool_use", id="tu_1", name="read_file", input={"path": "a.md"})
    client = FakeClient(Response([Block("thinking"), use], stop_reason="tool_use"), final("Done."))
    conv = ClaudeModel(client=client).conversation(system="S", tools=[READ])

    first = await conv.send("read a.md")
    assert first.calls == (ToolCall("tu_1", "read_file", {"path": "a.md"}),)

    second = await conv.send_results([(first.calls[0], ToolResult("contents", is_error=False))])

    assert second.answer == Answer("Done.")
    msgs = client.calls[1]["messages"]
    assert msgs[1]["role"] == "assistant" and [b["type"] for b in msgs[1]["content"]] == [
        "thinking",
        "tool_use",
    ]
    assert msgs[2] == {
        "role": "user",
        "content": [
            {"type": "tool_result", "tool_use_id": "tu_1", "content": "contents", "is_error": False}
        ],
    }


async def test_refusal() -> None:
    client = FakeClient(Response([], stop_reason="refusal"))

    turn = await ClaudeModel(client=client).conversation(system="S", tools=[]).send("x")

    assert turn.refused


@pytest.mark.parametrize(
    "response",
    [
        Response([Block("text", text='{"spoken": "cut')], stop_reason="max_tokens"),
        Response([Block("text", text="plain")]),
    ],
)
async def test_truncated_or_malformed_answers_are_errors(response: Response) -> None:
    with pytest.raises(BrainError):
        await ClaudeModel(client=FakeClient(response)).conversation(system="S", tools=[]).send("x")


async def test_api_failures_raise_brain_error() -> None:
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    client = FakeClient(anthropic.APIConnectionError(request=request))  # type: ignore[arg-type]

    with pytest.raises(BrainError):
        await ClaudeModel(client=client).conversation(system="S", tools=[]).send("x")


async def test_model_is_configurable() -> None:
    client = FakeClient(final("ok"))

    await (
        ClaudeModel(client=client, model="claude-haiku-5-5")
        .conversation(system="S", tools=[])
        .send("x")
    )

    assert client.calls[0]["model"] == "claude-haiku-5-5"


# -- research mode ---------------------------------------------------------------------


async def test_research_mode_drops_the_answer_schema_and_adds_web_search() -> None:
    client = FakeClient(
        Response([Block("tool_use", id="r", name="report_findings", input={"spoken": "Ok."})])
    )
    conv = ClaudeModel(client=client).conversation(
        system="SYS", tools=[READ], mode="research", web_search=True
    )

    turn = await conv.send("Task: look into CI")

    assert turn.calls == (ToolCall("r", "report_findings", {"spoken": "Ok."}),)
    call = client.calls[0]
    assert call["output_config"] == {"effort": "high"}  # no format: it reports with a tool
    assert call["tools"][-1] == {"type": "web_search_20260209", "name": "web_search", "max_uses": 5}
    assert call["timeout"] >= 60


async def test_research_without_web_search() -> None:
    client = FakeClient(Response([Block("text", text="done")]))
    conv = ClaudeModel(client=client).conversation(system="S", tools=[READ], mode="research")
    await conv.send("x")
    assert all(t.get("type") != "web_search_20260209" for t in client.calls[0]["tools"])


async def test_a_paused_server_turn_is_resumed_and_its_searches_reported() -> None:
    search = Block(
        "server_tool_use", id="s1", name="web_search", input={"query": "livekit text streams"}
    )
    client = FakeClient(
        Response([search, Block("web_search_tool_result")], stop_reason="pause_turn"),
        Response(
            [Block("tool_use", id="c1", name="read_file", input={"path": "a.md"})],
            stop_reason="tool_use",
        ),
    )
    conv = ClaudeModel(client=client).conversation(
        system="S", tools=[READ], mode="research", web_search=True
    )

    turn = await conv.send("x")

    assert turn.searches == ("livekit text streams",)
    assert turn.calls == (ToolCall("c1", "read_file", {"path": "a.md"}),)
    # Resumed by resending the paused assistant turn, with no extra user message.
    second = client.calls[1]["messages"]
    assert [m["role"] for m in second] == ["user", "assistant"]


async def test_endless_pausing_is_an_error() -> None:
    paused = Response(
        [Block("server_tool_use", id="s", name="web_search", input={"query": "q"})],
        stop_reason="pause_turn",
    )
    client = FakeClient(*[paused] * 10)
    conv = ClaudeModel(client=client).conversation(
        system="S", tools=[READ], mode="research", web_search=True
    )
    with pytest.raises(BrainError, match="kept pausing"):
        await conv.send("x")


async def test_a_plain_research_answer_is_never_read_aloud() -> None:
    client = FakeClient(
        Response([Block("text", text="## Findings\nSee https://x.example and `ci.yml`")])
    )
    conv = ClaudeModel(client=client).conversation(system="S", tools=[READ], mode="research")
    turn = await conv.send("x")
    assert turn.answer is not None
    assert "https" not in turn.answer.spoken and "#" not in turn.answer.spoken
    assert "https://x.example" in turn.answer.details
