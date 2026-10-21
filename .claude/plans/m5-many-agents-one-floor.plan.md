# Plan: Many agents, one floor

**Source PRD**: `.claude/prds/mooz.prd.md`
**Selected Milestone**: 5. Many agents, one floor
**Complexity**: Large

## Summary
Several agents can share a meeting and talk to each other, and mooz makes them take turns: one
speaker at a time, people first. An exchange between agents pauses after 3 agent-to-agent turns
until a person clicks **Continue**. Agent names that could wake the wrong agent (or that sound
like a person's name) are refused.

## Decisions (to confirm)
1. **The mooz server keeps the floor.** Before an agent posts or speaks an answer, it asks the
   server for a turn. The server grants one turn at a time, answers to people ahead of
   agent-to-agent replies, then first come first served. A turn lasts at most 45 seconds and ends
   when the agent says it's done, leaves, or is removed. The alternative, agents negotiating over
   the data channel, needs no server work but races, and leaves no single pause state for the UI.
2. **What the 3-turn pause counts.** A turn that answers another agent counts; a turn that
   answers a person resets the count. At 3, the next agent-to-agent reply is held, not dropped.
   The meeting shows "The agents have gone back and forth 3 times. Continue?" Any person in the
   meeting can click it (not only the host), and the held reply then goes out. A person asking an
   agent something also resets the count.
3. **People first.** An agent waits for people to stop talking before it starts (up to 5
   seconds). It stops speaking if a person talks over it for more than a second; its chat answer
   stays.
4. **Names that can't be confused.**
   - Refuse an agent name that the wake-word detector would hear as an existing agent's or
     person's name. This uses the detector's own "same word" test, so "Atlis" next to "Atlas" is
     refused, and the last word of a multi-word name counts ("Zach's Grok" collides with "Grok").
   - At least 3 characters.
   - The most common English words are refused (on top of today's reserved words).
   - People's names likewise can't sound like an agent's name.
   - **No LLM check for "addressed or mentioned".** This resolves the PRD question. Fuzzy rules
     stay, measured on a shared corpus that grows multi-agent cases.
5. **The bridge gets the connector's text escaping.** The same rules apply to its transcript:
   NFKC, ` ⏎ ` for typed line breaks, and hidden characters stripped. A shared case file keeps
   the Python and TypeScript versions identical. This matters more once agents feed each other
   text.

## Patterns to Mirror
| Category | Source | Pattern |
|---|---|---|
| In-memory state | `apps/web/lib/connector-queue.ts` (`STORE`, `stateFor`, `sweep`) | `globalThis` symbol map, swept, test reset helper |
| Capability auth | `apps/web/lib/agents.ts` `getClaimStatus` | Bearer claim secret hashed in `agent_requests` |
| Owner-tab auth | `apps/web/lib/connector-agents.ts` `requireConnectorAgent` | Participant cookie and owner key |
| Room state to clients | `apps/web/lib/notes.ts` `notesMetadata` + `setRoomMetadata` | LiveKit room metadata JSON |
| Errors | `apps/web/lib/http.ts` `HttpError`, `errorResponse` | Code + human message |
| Bridge HTTP | `bridge/src/mooz_agent/claim.py` | httpx, `_raise_for_error`, `ClaimError` |
| Bridge speech | `bridge/src/mooz_agent/speaking.py` `Mouth.say` | Chat first, then TTS frames, under a lock |
| Shared corpus | `bridge/tests/addressing_cases.json` | JSON cases run by pytest and Vitest |
| Tests | `apps/web/app/mcp/[secret]/route.test.ts`, `bridge/tests/test_agent.py` | Route handlers called directly; fakes for providers |
| E2E | `apps/web/e2e/agent-in-meeting.spec.ts`, `fixtures.ts` `bringAgent` | Real bridge with `MOOZ_PROVIDERS=fake` |

## Files to Change
| File | Action | Why |
|---|---|---|
| `bridge/src/mooz_agent/transcript.py`, `bridge/tests/text_cases.json`, `apps/web/lib/text.test.ts` | UPDATE / CREATE | Escaping parity, one shared case file |
| `apps/web/lib/addressing.ts` | UPDATE | Export the detector's same-word test |
| `apps/web/lib/names.ts` (+ tests), `bridge/tests/addressing_cases.json` | UPDATE | Collision-proof names, multi-agent cases |
| `apps/web/lib/floor.ts` (+ tests) | CREATE | Turns, queue, holds, the 3-turn pause, Continue |
| `apps/web/lib/room-state.ts` (+ tests) | CREATE | One room-metadata document: notes + floor |
| `apps/web/app/api/agent/claim/[id]/turns/**` | CREATE | Bridge turns (Bearer claim secret) |
| `apps/web/app/api/rooms/[slug]/connector-requests/[id]/turns/**` | CREATE | Connector turns (owner cookies) |
| `apps/web/app/api/rooms/[slug]/agents/continue/route.ts` | CREATE | A person lets the agents continue |
| `apps/web/app/api/livekit/webhook/route.ts`, `agents/[identity]/remove` | UPDATE | Free the floor when an agent leaves or is removed |
| `bridge/src/mooz_agent/turns.py` (+ tests), `speaking.py`, `agent.py`, `room.py` | CREATE / UPDATE | Take turns, people first, fall back to the local cap on older servers |
| `bridge/src/mooz_agent/brain.py`, `providers/*`, `providers/fakes.py` | UPDATE | Brains know who else is here and how to ask them (`@Name`); fake "ask/ping NAME" |
| `apps/web/components/ConnectorAgent.tsx`, `lib/voice/speaker.ts` | UPDATE | The connector agent takes turns; stops for people |
| `apps/web/components/FloorStrip.tsx`, `AgentsPausedBanner.tsx`, `MeetingRoom.tsx` | CREATE / UPDATE | Who's speaking, who's next; the Continue banner |
| `apps/web/e2e/agent-floor.spec.ts` | CREATE | Two agents ping-pong, pause, Continue; one speaker at a time |
| `docs/protocol.md`, `README.md`, PRD | UPDATE | "Taking turns" protocol, docs, status |

## Tasks
### Task 1: Bridge text escaping parity
- **Action**: Port `flatten` (hidden characters, NFKC, ` ⏎ `) to `transcript.py`. Move the escaping
  cases to `bridge/tests/text_cases.json`, run by both pytest and Vitest. Add the "only the leading
  tag is real" sentence to the bridge's transcript header.
- **Validate**: pytest and Vitest on the shared cases; the existing prompt tests are updated.

### Task 2: Names that can't be confused
- **Action**: `sameWord` is exported from `addressing.ts`. `parseAgentName` refuses a name with
  any word form (whole name, last word) that the detector would hear as a taken name's form, or
  the reverse. Names need at least 3 characters, and about 300 common English words are refused.
  `parseDisplayName` refuses a person's name that collides with an agent's. Add multi-agent
  addressing cases (two agents, agents naming each other, "ask Nova what Atlas thinks").
- **Validate**: Vitest table tests; both detectors pass the shared corpus.

### Task 3: The floor
- **Action**: Add `lib/floor.ts`, one floor per meeting in memory.
  - `request(agent, { answering, speak })` returns a turn: waiting, held or granted.
  - Answers to people go ahead of agent replies, then first come first served.
  - One granted turn at a time, at most 45 s. `done`, a leaving agent or the timeout ends it.
  - The streak and pause behave as decided; `continueAgents(by)` releases the held turn.
  - A waiting turn expires if its agent stops asking (10 s).
  - `lib/room-state.ts` publishes `{ notes_allowed, floor: { speaking, next, paused } }` as room
    metadata, debounced.
- **Validate**: Vitest on ordering, priority, timeouts, leave and removal, the pause, Continue,
  and the sweep.

### Task 4: Turn routes
- **Action**:
  - Bridge: `POST /api/agent/claim/{id}/turns` `{ answering, speak }` with the Bearer claim
    secret. It long-polls up to 25 s, then `GET …/turns/{turn}` keeps waiting, and
    `POST …/turns/{turn}/done` ends it.
  - Connector: the same under `connector-requests/{id}/turns`, with owner cookies.
  - People: `POST /api/rooms/{slug}/agents/continue`, which needs a participant cookie and a
    same-origin request.
  - The webhook and host removal free the floor.
  - Rate limits and body caps as in M4.
- **Validate**: route tests (auth, long-poll, timeout, removal, Continue only for people).

### Task 5: The bridge takes turns
- **Action**:
  - `turns.py` (httpx) takes a turn before `Mouth.say` posts and speaks, and ends it after.
  - People first: wait while a person is speaking (from LiveKit active speakers), up to 5 s. Stop
    the speech if a person talks over it for more than 1 s.
  - On a server without the API (404), fall back to today's local 3-in-a-row cap.
  - The brain is told who else is here and to ask them with `@Name` only when it helps. The fake
    brain gets "ask NAME …" and "ping NAME".
- **Validate**: pytest unit tests (turn client, Mouth ordering, barge-in); a live LiveKit test with
  two agents, which never overlap.

### Task 6: The connector agent takes turns
- **Action**:
  - `ConnectorAgent` takes a turn before posting an answer, "Yes?" or the filler, and ends it
    afterwards.
  - `AgentSpeaker` gains `stop()` for people first, with human speaking taken from the owner's
    meeting connection.
  - The connector ears' local agent cap moves to the server.
- **Validate**: Vitest on the speaker and the turn helper; the connector E2E still passes.

### Task 7: Meeting UI and E2E
- **Action**:
  - `FloorStrip`: "🤖 Kainoa's Atlas is speaking · next: Zach's Nova".
  - `AgentsPausedBanner`, with Continue for people only.
  - `agent-floor.spec.ts`: Kai asks "@Atlas ping Nova". After 3 agent-to-agent turns the banner
    shows and exactly 4 agent messages are in chat. Continue releases the held reply, and the
    exchange pauses again 3 turns later.
  - `@everyone` gets both agents answering, one at a time.
- **Validate**: Playwright, plus the full suite.

### Task 8: Docs, reviews, close
- **Action**:
  - `docs/protocol.md` gets a "Taking turns" section. Update the README ("Many agents"), the
    PRD (the naming question and M5 status) and the known limits.
  - Run `security-reviewer` on Tasks 3–6 (turn auth, floor starvation, pause bypass, Continue
    spoofing) and `code-reviewer` on the milestone diff. Fix every finding, then re-review.
- **Validate**: the full validation block; CI green.

## Validation
```bash
pnpm -C apps/web lint && pnpm -C apps/web typecheck && pnpm -C apps/web exec vitest run --coverage
pnpm -C apps/web exec playwright test
cd bridge && uv run ruff check && uv run ruff format --check && uv run mypy && uv run pytest -m "not live" --cov --cov-fail-under=80
```

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| A stuck turn blocks every agent (crash, lost webhook) | Medium | 45 s cap per turn; waiting turns expire unless re-polled; leave and removal free the floor |
| Each answer waits for an HTTP round trip | Medium | One request per turn, granted at once when the floor is free; measured in the live test |
| Barge-in fires on noise or echo | Medium | Only other people's tracks count, 1 s threshold, echo cancellation on their mics; chat answer always stays |
| Older bridges ignore the floor | Low | Documented; their local cap still applies; the host can remove them |
| Agents loop and run up cost | Medium | The 3-turn pause, held (not resent) until Continue |
| Names refused that people expect to use | Medium | Clear error messages naming the clash; owners can pick another name |
| Long-poll requests pile up | Low | One open request per agent; rate limits; 25 s poll windows |

## Acceptance
- [x] All tasks complete, each a conventional commit merged to `main`
- [x] Validation passes in CI, coverage at 80% or higher for web and bridge
- [x] Never two agents speaking at once; people first
- [x] Agent-to-agent exchanges pause after 3 turns until a person clicks Continue, and the held reply goes out
- [x] Names that the detector could confuse are refused, for agents and people
- [x] Bridge and web escape meeting text identically (shared cases)
- [x] `security-reviewer` and `code-reviewer` gates passed, every finding fixed and re-reviewed
- [ ] Live check with two real agents (needs your keys): moved to the release's live checks ([docs/releasing.md](../../docs/releasing.md#5-two-real-agents), check 5)
