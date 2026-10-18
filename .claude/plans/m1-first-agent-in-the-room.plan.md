# Plan: First agent in the room

**Source PRD**: `.claude/prds/mooz.prd.md`
**Selected Milestone**: 1 — First agent in the room
**Complexity**: Large

## Summary
Stand up the thinnest end-to-end path through mooz. Two people meet by link in a browser. One of them runs `mooz-agent connect <code>` on their own machine, and the host approves the agent. The agent then answers in chat and by voice whenever its name is spoken or `@mentioned`. This slice proves the riskiest parts first: owner-side speech-to-text over per-person audio tracks, name detection, and an agent joining with a scoped token so the host's server never holds AI keys. Memory, tools, async tasks, the connector door, and multi-agent floor control are later milestones.

## Key architecture decisions (this milestone)
- **The bridge is an ordinary LiveKit participant.** It connects with a scoped room token issued by the mooz server after host approval, using the `livekit` Python `rtc` SDK. LiveKit's own signaling and TURN handle NAT traversal, so no custom relay server is needed. **Not LiveKit Agents workers:** worker registration needs the server's API secret, which participants must never get.
- **Per-track speech-to-text, on the owner's side.** The bridge subscribes to each *human* audio track and runs one standalone `livekit-plugins-elevenlabs` STT stream per track, following LiveKit's standalone STT pattern ([docs](https://docs.livekit.io/agents/models/stt)). Speaker identity comes from the track's participant, so no diarization is needed.
- **Agents read each other through chat, not audio.** Every agent reply is posted as a text stream on topic `lk.chat`. Other agents read that text instead of transcribing it, which is cheaper and exact, and it is the hook for M5's turn counting.
- **The bridge protocol (v0) is LiveKit plus a small schema.** Participant attributes `{kind: "agent", owner_id, owner_name, door: "bridge"}` and JSON messages on topic `mooz.v0` (agent status, and later tasks). It is documented in `docs/protocol.md` so non-Python agents can implement it.
- **Pluggable providers from day one.** `Brain`, `SpeechToText` and `TextToSpeech` are Python protocols. M1 ships `ClaudeBrain` (Anthropic Messages API, model configurable, default the current Sonnet; confirm IDs with the `claude-api` skill at build time), `ElevenLabsSTT` and `ElevenLabsTTS`, plus fakes for tests. Grok and local voice slot in later without touching core code.
- **No accounts.** The host is identified by a random host secret in an HTTP-only cookie. Participants get LiveKit tokens (short TTL) from `/api/rooms/{slug}/join`.

## Patterns to Mirror
The repository has no code yet, so this milestone establishes the patterns and there is nothing existing to mirror. Conventions come from ECC rule packs:

| Category | Source | Pattern |
|---|---|---|
| Naming | ECC `rules/typescript/coding-style.md`, `rules/python/coding-style.md` | TS: camelCase functions, PascalCase components. Python: snake_case modules, typed public APIs |
| Errors | ECC `rules/common/patterns.md` | Typed errors at boundaries. API routes return `{ error: { code, message } }` with correct HTTP status. Bridge exits non-zero with a human-readable message |
| Tests | ECC `rules/common/testing.md`, `rules/python/testing.md` | TDD (red, green, refactor), AAA structure, 80%+ coverage, `pytest.mark.unit` and `pytest.mark.integration` markers, Vitest for web units, Playwright for E2E |
| Commits | ECC `rules/common/git-workflow.md` | `feat:` / `test:` / `chore:` conventional commits, one per task, merged to `main` per CLAUDE.md |

## Files to Change
| File | Action | Why |
|---|---|---|
| `apps/web/` (Next.js App Router, TypeScript) | CREATE | Meeting web app |
| `apps/web/app/page.tsx` | CREATE | "New meeting" landing page |
| `apps/web/app/r/[slug]/page.tsx` | CREATE | Meeting room: join form, video grid, chat, agent approval tray, "Bring my agent" dialog |
| `apps/web/app/api/rooms/route.ts` | CREATE | Create room, set host cookie |
| `apps/web/app/api/rooms/[slug]/join/route.ts` | CREATE | Issue LiveKit participant token |
| `apps/web/app/api/rooms/[slug]/agent-codes/route.ts` | CREATE | Issue one-time agent join code bound to the requesting participant (owner) |
| `apps/web/app/api/agent/claim/route.ts`, `apps/web/app/api/agent/claim/[id]/route.ts` | CREATE | Bridge redeems code and polls for approval, then receives a scoped agent token |
| `apps/web/app/api/rooms/[slug]/agent-requests/route.ts` | CREATE | Host lists, approves or denies pending agents |
| `apps/web/lib/db.ts`, `apps/web/lib/schema.ts` | CREATE | SQLite (better-sqlite3 + Drizzle): rooms, host secrets, agent codes, agent requests |
| `apps/web/lib/names.ts` | CREATE | Agent-name validation: unique per room, blocklist (common words, "mooz", "everyone", "agents") |
| `apps/web/lib/livekit.ts` | CREATE | Token minting with per-kind grants (agents: audio and data only, no video, cannot impersonate) |
| `apps/web/components/AgentTile.tsx`, `apps/web/components/AgentBadge.tsx` | CREATE | "🤖 Owner's Name" labeling (Q29) |
| `bridge/pyproject.toml` (uv), `bridge/src/mooz_agent/` | CREATE | Python package and `mooz-agent` CLI |
| `bridge/src/mooz_agent/cli.py` | CREATE | `mooz-agent connect CODE --server URL --name Atlas` |
| `bridge/src/mooz_agent/session.py` | CREATE | Room connection, track subscription, chat send and receive |
| `bridge/src/mooz_agent/listening.py` | CREATE | Per-track STT fan-out and rolling transcript buffer (last N minutes, memory only) |
| `bridge/src/mooz_agent/addressing.py` | CREATE | Name detection: phonetic and fuzzy match on final transcripts plus `@Name` in chat |
| `bridge/src/mooz_agent/providers/{base,claude,elevenlabs,fakes}.py` | CREATE | Brain, STT and TTS protocols and implementations |
| `bridge/src/mooz_agent/speaking.py` | CREATE | TTS to `rtc.AudioSource` published track, with a reply posted to `lk.chat` |
| `bridge/tests/` | CREATE | Unit and integration tests |
| `docker-compose.yml`, `livekit.yaml`, `.env.example` | CREATE | `livekit-server` (dev) plus the web app. No AI keys on the server |
| `docs/protocol.md` | CREATE | Bridge protocol v0 |
| `.github/workflows/ci.yml` | CREATE | Lint, typecheck, unit, integration (LiveKit dev server in a service container), E2E |
| `README.md`, `LICENSE` (MIT) | UPDATE / CREATE | Quickstart for this milestone |

## Tasks
### Task 1: Monorepo scaffold and CI
- **Action**: Create `apps/web` (Next.js, TypeScript strict, ESLint, Vitest, Playwright) with pnpm, and `bridge` (uv, ruff, mypy, pytest-cov). Add the MIT LICENSE, `.env.example`, and a CI workflow running every check below.
- **Mirror**: ECC `rules/typescript`, `rules/python`.
- **Validate**: `pnpm -C apps/web lint && pnpm -C apps/web typecheck && pnpm -C apps/web test` and `cd bridge && uv run ruff check && uv run mypy src && uv run pytest`.

### Task 2: Local LiveKit stack
- **Action**: Add `docker-compose.yml` with `livekit/livekit-server --dev` (pinned tag), `livekit.yaml`, and the web service. Add a health route `/api/health`.
- **Validate**: `docker compose up -d && curl -fsS localhost:3000/api/health && curl -fsS localhost:7880`.

### Task 3: Rooms, host cookie, participant tokens (TDD)
- **Action**: SQLite schema. `POST /api/rooms` creates a slug and sets an HTTP-only host secret. `POST /api/rooms/{slug}/join {name}` returns a LiveKit token (identity `p_<random>`, kind `human`, 2h TTL).
- **Validate**: Vitest route tests (create, join, unknown room returns 404, name required, host cookie flags).

### Task 4: Meeting room UI
- **Action**: The join form, then `LiveKitRoom` with the video grid, mic and camera controls, and chat on `lk.chat`. Agent participants render `AgentTile` with a badge and owner label.
- **Validate**: Playwright with two browser contexts and fake media: both see each other's tiles, and a chat message round-trips.

### Task 5: Agent join codes, host approval, scoped agent token (TDD, security-sensitive)
- **Action**: "Bring my agent" mints a one-time code (10-minute expiry, bound to the owner's participant identity) and shows `mooz-agent connect CODE --server <origin>`. `POST /api/agent/claim {code, name}` validates the name (unique, blocklist) and creates a pending request. The host tray lists requests with approve and deny. `GET /api/agent/claim/{id}` returns the agent token only after approval. The agent token grants audio publish plus data publish and subscribe, with no video, attributes `{kind:"agent", owner_id, owner_name, door:"bridge"}`, and identity `a_<random>` the client cannot set.
- **Validate**: Vitest: reused code is rejected, an expired code is rejected, a duplicate or blocked name is rejected, the token is withheld before approval, a non-host cannot approve, and agent grants contain no video. Playwright: host sees the request, approves, and the request clears.
- **Review gate**: `security-reviewer` pass on this task.

### Task 6: Bridge CLI and room session
- **Action**: `mooz-agent connect` redeems the code, polls for approval, connects with the `rtc` SDK, publishes an audio track, subscribes to human audio tracks, and sends and receives on `lk.chat`. Ctrl-C leaves cleanly.
- **Validate**: pytest integration (marker `integration`) against the compose LiveKit server, using a fake-approved token: the bridge joins and its participant shows `kind=agent`.

### Task 7: Listening: per-track STT and rolling transcript (TDD)
- **Action**: One STT stream per human track (standalone plugin pattern). Final segments are appended to an in-memory buffer `{speaker_id, speaker_name, text, t}`. Old entries are evicted after a configurable window.
- **Validate**: Unit tests with `FakeSTT` covering multi-speaker attribution, eviction, and track unsubscribe ending its stream.

### Task 8: Addressing (TDD)
- **Action**: Detect when the agent is addressed via fuzzy and phonetic name match (rapidfuzz plus a metaphone-style encoding) on final segments, or `@Name` in chat. Return the question span plus the asker identity.
- **Validate**: A table-driven test corpus (at least 40 cases): "hey atlas", "Atlis" (an STT typo), "atlas, can you…", mid-sentence mention without address (should not wake; record the false-wake rate as a baseline metric), `@Atlas` in chat, and a different agent's name.

### Task 9: Brain and speaking (TDD)
- **Action**: The `Brain.answer(question, transcript_context, asker)` protocol, with `ClaudeBrain` behind it (system prompt: concise spoken answer plus optional details for chat). `speaking.py` posts the full answer to `lk.chat`, then streams TTS of the spoken part into the published track. `ElevenLabsTTS` uses the owner's voice ID from config.
- **Validate**: Unit tests with `FakeBrain` and `FakeTTS` (the chat message is sent before audio, and the audio frames are published). One opt-in live test (`MOOZ_LIVE_TESTS=1`) hits the real Anthropic and ElevenLabs APIs.

### Task 10: End-to-end slice and docs
- **Action**: An E2E test: two humans plus a bridge running fake providers. A human types `@Atlas what is 2+2` and the agent's chat reply appears, labeled as an agent. Write `docs/protocol.md` v0. Write a README quickstart (compose up, open link, run bridge with keys in the *bridge's* `.env`). Record the latency metric in the bridge logs (name detected, first TTS frame).
- **Validate**: The full validation block below passes in CI. Manual check: a real voice meeting with ElevenLabs and Claude keys, with "Hey Atlas" answered aloud.

## Validation
```bash
# web
pnpm -C apps/web lint && pnpm -C apps/web typecheck && pnpm -C apps/web test -- --coverage
pnpm -C apps/web exec playwright test
# bridge
cd bridge && uv run ruff check && uv run mypy src && uv run pytest -m "not live" --cov=mooz_agent --cov-fail-under=80
# stack
docker compose up -d && curl -fsS localhost:3000/api/health
```

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| Standalone ElevenLabs STT plugin API differs from docs, or per-key concurrency limits bite with 6 tracks | Medium | Spike in Task 7 first. Fall back to ElevenLabs' realtime WebSocket directly behind the same `SpeechToText` protocol |
| JS chat components and Python `send_text` disagree on `lk.chat` format or version | Medium | Pin `livekit` (Python), `livekit-client` and `@livekit/components-react` versions together. Task 6 integration test asserts the round-trip |
| Name false wakes from mid-sentence mentions | High | Task 8 measures a baseline. `@Name` is the deterministic path. An LLM "is this addressed to me" check is deferred to M5 if the baseline is poor |
| Agent hears humans' speakers playing its own voice | Low | It only transcribes human tracks, and browser WebRTC echo cancellation suppresses playback |
| Join-code or token abuse | Medium | One-time short TTL codes, host approval, server-assigned identities, minimal grants, security review gate on Task 5 |
| CI flakiness with WebRTC fake media | Medium | Use Chromium `--use-fake-device-for-media-stream`. E2E asserts on chat and participant presence, not media quality |

## Acceptance
- [x] All tasks complete, each as its own conventional commit, merged to `main`
- [x] Validation passes in CI, with web (95%) and bridge (93%) coverage at 80% or higher
- [ ] Manual voice demo: "Hey Atlas, …" is answered aloud and in chat within the latency target (p50 under 2.5s), measured and logged. **Open: needs real Anthropic and ElevenLabs keys.** Run `MOOZ_LIVE_TESTS=1 uv run pytest -m live`, then a two-person call. The bridge logs `latency heard→voice` for every answer.
- [x] The mooz server and `.env.example` contain no AI or voice keys (keys live only in the bridge's environment)
- [x] `code-reviewer` pass on the full milestone diff (1 critical and 2 high findings fixed in 3a96c48) and `security-reviewer` pass on Task 5 (fixed in b651faa and dbf770b)
- [x] Patterns established and documented for later milestones to mirror (`docs/protocol.md`, provider protocols with fakes)

## Deviations from this plan
- SQLite uses Node's built-in `node:sqlite` with hand-written migrations instead of better-sqlite3 + Drizzle (no native build step, fewer dependencies).
- Default model is `claude-opus-5-5` at low effort (current Anthropic guidance) instead of Sonnet. It can be overridden with `MOOZ_CLAUDE_MODEL`.
- Agents render as compact cards rather than video tiles (they have no camera).
- Added beyond the plan, from the reviews: host removal of agents, single-use agent tokens, a LiveKit webhook that kicks removed agents, pending-request expiry, and the agent-to-agent streak guard.
