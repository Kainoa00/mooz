# Plan: Async research tasks

**Source PRD**: `.claude/prds/mooz.prd.md`
**Selected Milestone**: 3 — Async research tasks
**Complexity**: Large

## Summary
Today a question that needs real digging runs into the 20-second spoken budget: the agent says it can't finish and gives up. M3 turns that into **background work**. The owner says "Atlas, look into why CI is failing on main". The agent replies "On it", keeps listening and answering other questions, shows its progress in a task panel, and later reports back by voice and chat.

Research covers the owner's folders and repos (from M2), their **GitHub** issues, PRs and CI (moved here from M2), and optionally **the web**. Only the owner can start tasks, as the PRD requires. Everyone can see what an agent is working on, the same transparency principle as the notes banner.

## Decisions (confirmed 2026-10-18)
1. **Web research.** Owner tasks can search the web: Claude's server-side `web_search_20260209`, and xAI's `{"type": "web_search"}` for Grok. It's on by default for owner tasks, never available for guests' questions, and can be turned off per agent (`web_search = false` in `agent.toml`). It costs the owner's provider usage, capped at 5 searches per task. Web fetch (opening arbitrary URLs) stays off: it would be an exfiltration channel for anything the agent can read.
   - **Changed after the security review:** xAI's web search also opens web pages, the same exfiltration channel, so it is **off by default for Grok** (`init --web-search` or `web_search = true` turns it on, with a warning at connect). Claude stays on by default. The cap is about 5 per task: a step that pauses mid-search can run a few more.
2. **Private results.** If the owner says "…privately" or "…just for me", the result goes only to the owner: their task panel, plus a direct chat message to them. Nothing is spoken. Everyone else sees "🔒 Private task for Kainoa" with its status but not its title. By default, results go to the room as the PRD says.
3. **GitHub.** Read-only: issues, PRs (with review state and changed files) and CI check status. The owner provides a `GITHUB_TOKEN`; a fine-grained, read-only token is recommended. Repos are added like folders, with the same private and public rules: `mooz-agent sources add github:owner/repo [--public]`. Writing to GitHub (comments, issues) waits for a later milestone.
4. **Results are kept.** Every finished task is saved to the owner's private memory, tagged `task-result`. Like meeting notes, these stay out of the standing prompt and are found with `recall`. If the meeting ends while a task is running, the agent finishes it within its own time budget, saves it, and then exits; the CLI says so and Ctrl-C stops it at once.

## Key architecture decisions
- **Tasks live in the bridge, never on the mooz server.** This keeps to the PRD's rule that the server persists nothing but settings. A `TaskRunner` owns the tasks, runs at most 2 at a time (others wait in a queue), allows at most 20 per meeting, and enforces a per-task budget of 30 model turns, 60 tool calls and 10 minutes.
- **How a task starts:**
  - **Explicit:** the owner says "look into / research / dig into / investigate / find out / figure out …".
  - **Overflow:** an owner question that runs out of the spoken budget becomes a task ("This needs more digging. I'll keep at it and report back."), carrying the tool results gathered so far.
  - **Guests:** a guest's question that overflows gets "That needs more digging than I can do right now; Kainoa can ask me to look into it."
  - **Deterministic phrases** ("how's it going?", "what are you working on?", "stop that", "cancel the task") are answered from task state, without a model call, like the notes commands.
- **A research mode in each provider adapter.** The quick answer mode keeps its JSON answer schema. Research mode differs in four ways:
  - It ends when the model calls a strict `report_findings` tool (`spoken`, `details`, `sources`) rather than relying on `output_config.format`. That combination with web search's citations is undocumented, and the tool works the same on both providers.
  - It adds the web search server tool when enabled.
  - It handles Claude's `pause_turn` by resending, with no extra user message.
  - It runs at higher effort (`high` rather than `low`).
- **Progress comes from the ToolBox, not the model.** Each tool call gets a fixed, safe description ("Reading launch.md in plans", "Checking CI on main", "Searching the web for '…'"), which is redacted and streamed to the task panel. The voice stays quiet while work is in progress: it says "On it" at the start and reports when done.
- **Reporting back waits for a quiet moment.** The full result goes to chat (with `reply_to` set to the owner and `sources` set to whose words it drew on) and to the panel straight away. The spoken short version waits until no one has spoken for 2.5 seconds, up to 90 seconds; after that it's skipped, since chat already has it. The mouth's floor lock means the agent never talks over itself.
- **The wire format is two additions to the `mooz.v0` protocol:**
  - Topic `mooz.tasks` (text streams, so results can be long) carries JSON task events: `{type: "task", id, state: queued|working|done|failed|cancelled, title, owner, private, progress[], summary, details, started_at, updated_at}`, sent to everyone or only to the owner.
  - Browsers send `{type: "tasks?"}` on (re)connect, and agents answer directly, as with `notes?`.
  - The owner's panel can send `{type: "task.cancel", id}`; the agent honors it only from its owner's server-assigned identity.
- **Consent and access stay as in M2:**
  - Tasks run in owner scope.
  - While notes are on, task reports are tagged with their `sources` like any reply, so notes opt-outs keep working.
  - Tool output (files, GitHub issue text, web pages) is information, never instructions; a crafted issue or page is the main new injection path (see Risks).
- **GitHub client.** `httpx` against the REST API with a 10-second timeout. Rate-limit and auth errors become clear messages, and the token never appears in output or errors. All output is redacted and capped like file reads. Guests see public-marked GitHub sources only.

## Patterns to Mirror
| Category | Source | Pattern |
|---|---|---|
| Deterministic commands | `bridge/src/mooz_agent/notes.py:45` (`notes_command`) | Normalized phrase regexes, tested with a parametrized table |
| Background work + lifecycle | `bridge/src/mooz_agent/notes.py:63` (`NotesKeeper`), `agent.py:280` (`_notes_command`), `agent.py:409` (`aclose`) | Owner check by identity, announce before acting, flags for in-between states, save at shutdown |
| Tool loop + budgets | `bridge/src/mooz_agent/brain.py:121` (`ToolLoopBrain`), `brain.py:212` (`_loop`) | Provider-neutral loop over `Model`/`Conversation` protocols; budgets return fixed answers |
| Tools + scope | `bridge/src/mooz_agent/tools/toolbox.py:114` (`specs`), `:210` (`dispatch`) | Strict schemas filtered by scope; private and missing look identical; errors become `ToolResult(is_error=True)` |
| Provider adapters | `bridge/src/mooz_agent/providers/claude.py:38`, `grok.py:66` | Translate turns only; tested against fake clients that record request shapes |
| Offline model | `bridge/src/mooz_agent/providers/fakes.py:105` (`OfflineModel`) | Phrases become real tool calls so E2E exercises real tools |
| Room signals | `bridge/src/mooz_agent/room.py:163` (`send_signal`), `:169` (`_handle_data`) | JSON on `mooz.v0`, sender stamped by LiveKit, `to=[identity]` for direct replies |
| Browser side | `apps/web/components/NotesBanner.tsx:27` | Trust signals only from `kind=agent` about themselves; query state on (re)connect |
| E2E | `apps/web/e2e/fixtures.ts:73` (`bringAgent`), `e2e/agent-access.spec.ts` | Real bridge with offline providers and a throwaway `MOOZ_HOME` |

## Files to Change
| File | Action | Why |
|---|---|---|
| `bridge/src/mooz_agent/tasks.py` | CREATE | `Task`, `TaskRunner` (queue, budgets, cancel, events), `task_command` phrases |
| `bridge/src/mooz_agent/brain.py` | UPDATE | `research()` loop (report tool, progress callback, overflow handoff), research prompt |
| `bridge/src/mooz_agent/providers/claude.py`, `grok.py` | UPDATE | Research mode: web search tool, `pause_turn`, higher effort, no answer schema |
| `bridge/src/mooz_agent/providers/fakes.py` | UPDATE | Offline research ("look into X [slowly]") using real tools |
| `bridge/src/mooz_agent/tools/github.py` | CREATE | Read-only GitHub issues, PRs, CI checks |
| `bridge/src/mooz_agent/tools/toolbox.py` | UPDATE | GitHub tools, progress descriptions |
| `bridge/src/mooz_agent/config.py`, `cli.py` | UPDATE | `github:owner/repo` sources, `web_search` setting |
| `bridge/src/mooz_agent/agent.py`, `room.py` | UPDATE | Task commands, quiet-moment report, `mooz.tasks` events, `tasks?` and `task.cancel` |
| `apps/web/lib/tasks-protocol.ts` | CREATE | Parse and validate task events (client-safe) |
| `apps/web/components/TaskPanel.tsx`, `MeetingRoom.tsx` | CREATE / UPDATE | Panel above chat; cancel for the owner; private rows |
| `bridge/tests/…`, `apps/web/**/*.test.ts`, `apps/web/e2e/agent-tasks.spec.ts` | CREATE | Unit, live LiveKit and browser tests |
| `README.md`, `docs/protocol.md`, `bridge/.env.example` | UPDATE | Tasks, GitHub, web search, costs, wire format |

## Tasks
### Task 1: Task model and commands (TDD)
- **Action**: `task_command(text)` returns `start(topic, private)`, `status`, `cancel` or `None`. `Task` dataclass and `TaskRunner`: queue (2 running, 20 per meeting), state changes, budgets, cancel, and an `on_event` callback.
- **Mirror**: `notes_command` and `NotesKeeper`.
- **Validate**: unit tests for the phrase table, concurrency limit, budget exhaustion becoming `failed` with a plain reason, cancel during a tool call, and per-meeting cap.

### Task 2: Research loop in the brain (TDD)
- **Action**: `ToolLoopBrain.research(task, scope, on_progress)` uses a research system prompt and the strict `report_findings` tool, with the larger budget. On the owner's turns, `answer()` hands an overflow to the runner along with the tool results gathered so far, capped and redacted.
- **Mirror**: `_loop` and `summarize` in `brain.py`.
- **Validate**: ScriptedModel tests for a report ending the task, the progress callback per tool call, a missing report becoming `failed`, overflow handoff carrying results, and guests never starting tasks.

### Task 3: Research mode in the adapters (TDD)
- **Action**:
  - Claude: no `output_config.format`; add `web_search_20260209` with `max_uses: 5` when enabled; resend on `pause_turn` (cap 5); effort `high`; pass `response.content` back unchanged.
  - Grok: no `text.format`; add `{"type": "web_search"}`.
  - Both: surface server-side searches as progress.
- **Mirror**: the existing fake-client request-shape tests.
- **Validate**: request-shape tests for both adapters, `pause_turn` resume, web search off when disabled, a web search error result handled; opt-in live tests for both providers.

### Task 4: GitHub tools (TDD)
- **Action**: `github_issues`, `github_issue` (with comments, capped), `github_pulls`, `github_pull` (review state, changed files, check summary), `github_ci` (check runs for a branch, PR or ref). Uses `GITHUB_TOKEN` when set and redacts all output. `github:owner/repo` sources come with public/private flags and CLI support.
- **Mirror**: `tools/git.py` (validation, caps, safe errors) and `toolbox.py` scope filtering.
- **Validate**: `respx`-mocked API tests for each tool, guests limited to public GitHub sources, rate-limit and 401 messages without the token, owner/repo validation.

### Task 5: Tasks in the agent (TDD)
- **Action**: Wire the runner into `Agent`:
  - "On it" for explicit starts; overflow handoff.
  - Status and cancel phrases; owner-only checks.
  - Progress events on `mooz.tasks`; `tasks?` and `task.cancel` handling with sender checks.
  - Report back to chat right away and by voice at a quiet moment.
  - Private delivery; save to memory with `task-result`; finish running tasks on shutdown.
- **Mirror**: the notes commands and announcements in `agent.py`.
- **Validate**: agent tests for:
  - Guests refused.
  - Quick questions answered while a task runs.
  - The voice waiting for quiet.
  - Private results never spoken or broadcast.
  - Cancel from the owner honored and from others ignored.
  - Late joiner told.
  - Shutdown saving the result.
  - Notes opt-outs applied to task reports.

### Task 6: Task panel (web, TDD)
- **Action**: `lib/tasks-protocol.ts` parses and validates events, trusting only agents and only about their own tasks. `TaskPanel` sits above chat: rows with agent label, title, state, latest progress, and an expandable result. It shows Cancel only to the owner and redacts private rows for everyone else. It sends `tasks?` on (re)connect.
- **Mirror**: `NotesBanner.tsx` and `lib/notes-protocol.ts`.
- **Validate**: Vitest for parsing, validation, sender trust and ordering. Playwright covers it in Task 8.

### Task 7: Live LiveKit integration test
- **Action**: Real room: a long task event reaches a human over `mooz.tasks` text streams, a private event reaches only the owner, and cancel from the owner works while cancel from a guest is ignored.
- **Validate**: `uv run pytest -m integration`.

### Task 8: End to end, docs, reviews
- **Action**: Playwright `agent-tasks.spec.ts`:
  - The owner starts a task, the panel shows working and then done, and the result appears in chat.
  - A guest can't start one.
  - The owner cancels a slow task from the panel.
  - A private task's result is visible only to the owner.

  Docs: README "Background research" (starting, checking, cancelling, private, GitHub token, web search, costs) and `docs/protocol.md` (task events, queries, cancel).

  **Review gates:** `security-reviewer` on Tasks 2–5 (new injection surfaces: GitHub text, web pages, overflow) and `code-reviewer` on the milestone diff; fix every finding, then re-review the fixes.
- **Validate**: the full validation block, plus the opt-in live tests.

## Validation
```bash
pnpm -C apps/web lint && pnpm -C apps/web typecheck && pnpm -C apps/web exec vitest run --coverage
pnpm -C apps/web exec playwright test
cd bridge && uv run ruff check && uv run ruff format --check && uv run mypy && uv run pytest -m "not live" --cov --cov-fail-under=80
MOOZ_LIVE_TESTS=1 uv run pytest -m live   # opt-in: real Claude and Grok research with web search, GitHub; costs money
```

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| Injection via GitHub issue text or web pages steers an owner-scope task into reading and announcing private files | Medium | "Information, not instructions" rule extended to research. No web fetch, so no URL exfiltration. Results are labelled with sources. Private delivery is available. Security review on Tasks 2–5. Documented in the README |
| xAI web search may not combine with custom function tools (undocumented) | Medium | Request-shape tests now. Live test with keys. If xAI rejects the combination, retry once without web search and say so in the task's progress |
| Claude web search with structured output (citations) | Low | Research mode doesn't use `output_config.format`; it ends with the `report_findings` tool |
| Cost of long tasks | Medium | Budgets per task (turns, tool calls, time, 5 web searches), 2 running, 20 per meeting. README cost section |
| Speaking over people when reporting | Medium | Wait for a quiet moment; give up the voice after 90 seconds, since chat has the result |
| Tasks outliving the meeting | Low | Finish within the task's own budget, save to memory, then exit; Ctrl-C stops at once |

## Acceptance
- [x] All tasks complete, each as its own conventional commit, merged to `main`
- [x] Validation passes in CI, with bridge and web coverage at 80% or higher (bridge 94%, web 95%)
- [x] Only owners start or cancel tasks; guests' questions never become tasks
- [x] The agent keeps answering while tasks run, and reports back by chat right away and by voice at a quiet moment (no one speaking, no one just finished)
- [x] Private results never reach anyone but the owner (and any owner request phrased privately is answered only to them)
- [x] The E2E task test passes in the browser with the real bridge
- [x] `security-reviewer` on the milestone (three re-review rounds) and `code-reviewer` on the milestone diff (approved after one re-review); every finding fixed or, for the residual prompt-injection risk, documented
- [ ] Opt-in live tests pass for Claude and Grok research with web search, and for GitHub (needs your keys)
