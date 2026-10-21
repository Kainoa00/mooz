# Plan: Local voice and launch

**Source PRD**: `.claude/prds/mooz.prd.md`
**Selected Milestone**: 6. Local voice and launch
**Complexity**: Large (11 tasks; the last one publishes v0.1.0, but only after your go-ahead)

## Summary
M6 gets mooz ready for other people to run it.

- **Local voice.** An agent owner can use a speech server on their own machine instead of ElevenLabs, in the bridge and in the connector tab.
  - Any server that speaks OpenAI's `/v1/audio/transcriptions` and `/v1/audio/speech` works. VoiceStudio is the one we document and test.
  - ElevenLabs stays the default.
  - The mooz server never sees a voice key or any audio.
- **Security backlog.** The open items get done:
  - rate limits on room creation, joins and claims
  - meeting rows deleted after the meeting
  - server-side session expiry
  - owners see requests made with their codes

  H3, H4 and H5 already shipped in M4, so their boxes just get ticked.
- **Meeting summary export.** The host downloads a Markdown file built in their own tab. It holds agents' public answers, task results and who was there. People's own words, private answers and anyone who opted out are left out. Nothing is stored on the server.
- **VPS guide.** A production compose kit (Caddy with automatic HTTPS, LiveKit without `--dev`) and a step-by-step guide. CI builds and smoke-tests the Docker image for the first time.
- **README, demo, v0.1.0.** A rewritten README, a recorded offline demo, a changelog, packaging, and a release workflow that runs on a tag. Pushing the tag and publishing anything need your go-ahead.

**Answer to the PRD open question (PRD:73).** Research as of 2026-10-20:
- **Chrome and Edge (142+), Firefox (153+):** an HTTPS meeting page can call `http://127.0.0.1:3900`. The browser asks once for a permission ("apps on this device"), and the speech server must send CORS headers.
- **Safari and every iOS browser:** blocked as mixed content (WebKit bug 171934 is still open).
- **A page served from `http://localhost`:** works in all of them.
- **Effect on the plan:** local voice in the tab ships for Chrome, Edge and Firefox. Safari users get a clear message and the bridge instead.

## Decisions (go-ahead given 2026-10-21; recommended options taken unless changed)
1. **Bridge local voice uses OpenAI's standard batch requests.**
   - **Hearing.**
     - The bridge cuts each person's audio into utterances with a small energy gate. The gate is a Python port of the browser's `SpeechGate` (`apps/web/lib/voice/gate.ts`), checked against cases shared with the TypeScript version.
     - Each utterance goes as a 16 kHz mono WAV to `POST {url}/audio/transcriptions` (`model`, `language`, `response_format=json`, `temperature=0`). No name prompt is sent; see Risks.
   - **Speaking.**
     - `POST {url}/audio/speech` with `response_format: "pcm"` (raw 24 kHz, 16-bit, mono) and `stream_format: "audio"`, read as a stream. `Mouth` already resamples to 48 kHz (`speaking.py:126-137`).
     - Answers go one sentence at a time, because VoiceStudio synthesizes a whole clip before sending any audio.
     - "Yes?" and "One sec, checking." are synthesized once at connect. That also warms the model.
   - **Main alternative:** LiveKit's Silero VAD with `StreamAdapter`. It is already installed and handles noisy rooms better. But its model license allows use "only together with the LiveKit Agents framework", which is unclear for MIT-licensed mooz.
   - **Other alternative:** VoiceStudio's own streaming WebSockets. Faster, but they only work with VoiceStudio.
   - Either can be added later behind the same provider seam.

2. **How an owner turns it on (bridge).**
   - **Switch:** `MOOZ_VOICE=local` in `bridge/.env`, or `voice_provider = "local"` in `agent.toml` (written by `mooz-agent init --voice-provider local`). The toml wins, as `model` does today.
   - **Settings, in `bridge/.env`:**
     - `MOOZ_SPEECH_URL`, default `http://127.0.0.1:3900/v1`
     - `MOOZ_STT_URL` and `MOOZ_TTS_URL`, optional, for separate servers
     - `MOOZ_STT_MODEL`, default `whisper-1`
     - `MOOZ_TTS_MODEL`, default `tts-1`
     - `MOOZ_TTS_VOICE`, default `default`; the agent's `voice_id` / `--voice` wins
     - `MOOZ_TTS_FORMAT`, `pcm` (default) or `wav`
     - `MOOZ_TTS_RATE`, default 24000
     - `MOOZ_SPEECH_API_KEY`, optional, sent as a Bearer token only when set
     - `MOOZ_STT_CONCURRENCY`, default 2
   - **Keyless demo:** `MOOZ_BRAIN=offline` pairs the offline brain with real voice. Anyone running VoiceStudio can try a talking agent with no keys at all.
   - **Alternative:** env vars only, and `MOOZ_PROVIDERS=fake` stays all-or-nothing.

3. **Local voice in the connector tab: yes, but only to this machine (loopback).**
   - **The setting:** it accepts only `http://127.0.0.1:<port>` or `http://localhost:<port>`, and the default is `http://127.0.0.1:3900/v1`. There is no key field.
   - **Hearing uses plain HTTP, no WebSocket.** That means no `ws:` source in the CSP. A multipart POST without custom headers also needs no CORS preflight.
   - **CSP:** `connect-src` always adds `http://127.0.0.1:*` and `http://localhost:*`, because the server can't know each owner's port. Scripts still need the per-request nonce, so this only lets pages reach services on the viewer's own machine. `[::1]` is left out because CSP host sources can't express IPv6 addresses.
   - **Test button:** it runs `GET {url}/models` when the owner saves. Chrome's permission prompt and CORS errors then show up during setup, not mid-meeting.
   - **Safari and iOS:** they see "use Chrome, Edge or Firefox, or run the bridge".
   - **Speech server on another machine:** the guide documents `ssh -L 3900:gpu-box:3900`, so the browser still sees loopback.
   - **Alternatives:**
     - Local voice in the bridge only. No CSP change, and the tab keeps ElevenLabs only.
     - An operator allow-list `MOOZ_VOICE_ORIGINS`. It covers https servers on a LAN, but the server admin isn't each agent owner.

4. **The documented server is VoiceStudio 0.5.7 or later.**
   - **What it is:** `github.com/debpalash/VoiceStudio`, AGPL-3.0. It is installed separately (PRD:57) and listens on `127.0.0.1:3900` with no key on loopback.
   - **Browser setup:** the guide spells out `OMNIVOICE_ALLOWED_ORIGINS`, which the tab needs. It must list the mooz origin plus VoiceStudio's own defaults (`http://localhost:3901,http://127.0.0.1:3901,app://voicestudio`), because setting it replaces them.
   - **Other servers:** a table covers Kokoro-FastAPI (speech only, port 8880), the whisper.cpp server (transcription only, run with `--inference-path /v1/audio/transcriptions`) and Speaches. It is marked "from their docs, not tested by us".
   - **Alternative:** document Kokoro-FastAPI plus whisper.cpp as the main pair. They have permissive licenses and are smaller. They need separate transcription and speech URLs, which are supported either way.

5. **VPS shape: one server, Docker with host networking, stock Caddy, two hostnames.**
   - **Routing:** `meet.example.com` goes to Next.js on `127.0.0.1:3000`, and `livekit.example.com` to LiveKit signalling on `127.0.0.1:7880`. Caddy gets the certificates and adds HSTS.
   - **LiveKit:**
     - It runs without `--dev`, which would expose `/debug/pprof` and skip LiveKit's secret check.
     - The key name is fixed as `mooz`. The secret lives only in `.env`: at least 32 characters, from `openssl rand -base64 48`.
     - The webhook goes to `http://127.0.0.1:3000/api/livekit/webhook`.
   - **Media:** one UDP port (7882), ICE over TCP on 7881, and TURN over UDP on 3478.
   - **No TURN over TLS on port 443 in the tested setup.** An appendix shows the caddy-l4 variant for networks that only allow 443, marked untested.
   - **Image:** it comes from GHCR (`ghcr.io/kainoa00/mooz-web:0.1.0`), with `build:` as the fallback.
   - **LiveKit version:** v1.13.10, the latest (2026-10-14), in both the dev and production compose files, so CI tests what the guide ships.
   - **Alternatives:**
     - nginx: it has rate limiting built in, but needs certbot, and its default access logs would record connector secrets in `/mcp/<secret>` paths.
     - LiveKit's generator output: its Caddy takes all of port 443 at the TCP level, so the app gets no forwarded headers.
     - Staying on LiveKit v1.13.7.

6. **Rate limits without IP addresses in the app (L5).**
   - **`POST /api/rooms`:** 30 a minute across the server (`MOOZ_ROOMS_PER_MINUTE`).
   - **`POST /api/rooms/{slug}/join`:** 30 a minute per room.
     - At most 200 participant rows per room; rejoins reuse their row. Past that the server answers 409 `room_full`.
     - The production LiveKit config also sets `room.max_participants: 20`.
   - **`POST /api/agent/claim`:** 10 a minute per code and 120 a minute across the server, checked before the SQLite write transaction.
   - **`GET /api/agent/claim/{id}`:** 60 a minute per claim (the bridge polls every 2 s, `claim.py:70`).
   - **All of them** answer 429 `rate_limited`, as today's routes do.
   - **Per-IP limits stay optional in the proxy.** The guide shows a Caddy build with `caddy-ratelimit`, and the README's "rate limit by IP" becomes "optional".
   - **Alternative:** per-IP limits in the app from `X-Forwarded-For`, behind `MOOZ_TRUST_PROXY=1`. Fairer, but spoofable when misconfigured, and the app would hold IP addresses in memory.

7. **What's left after a meeting, and for how long (L5 cleanup, H2).**
   - **When the meeting ends:** LiveKit sends `room_finished`, and the server deletes that room's participants, codes and agent requests.
   - **Without webhooks:** a sweep deletes anything expired. It runs at most once a minute, triggered by room creation and joins.
   - **The room itself** (link, host secret hash, notes policy) counts as a setting. It is kept for 30 days after its last join, then deleted.
   - **Sessions:**
     - Host and participant secrets expire on the server 24 hours after the last join. Each join resets the clock, matching today's cookie Max-Age of 86400 s.
     - A bridge's claim secret works for turn calls only while its owner's session is valid, and for at most 24 h after its token was issued.
   - **On disk:** SQLite `secure_delete` is on, and the WAL is checkpointed after any sweep that deletes rows, so deleted names don't linger on disk.
   - **Cost:** after LiveKit closes an empty room, someone who comes back to the same link gets a new identity and must set their notes opt-out again.
   - **Alternative:** delete the room with its meeting. Links become single-use and the host cookie dies with them.

8. **Off localhost, `MOOZ_PUBLIC_URL` is required (H3).**
   - The x-forwarded fallback stays for local use.
   - When `LIVEKIT_URL`'s host isn't local, the server refuses to start without `MOOZ_PUBLIC_URL`, and `/api/ready` fails.
   - It also refuses the `devkey` key name there.
   - Alternative: keep today's fallback and only document it.

9. **Owners see requests made with their codes (H6).**
   - **Routes:**
     - `GET /api/rooms/{slug}/my-agent-requests` (participant cookie) returns `{ requests: [{ id, agentName, status: "pending" | "approved", createdAt }] }`.
     - `POST /api/rooms/{slug}/my-agent-requests/{id}/withdraw` (participant cookie, same origin) turns pending into `denied`, and approved into `revoked` with a kick.
   - **What the owner sees:** "Atlas is waiting for the host. Not yours? Cancel it." It appears in the dialog and in a small tray while any of their requests is pending.
   - **Alternative:** the host can't approve until the owner confirms. Stronger, but it adds a click to every bring.

10. **Meeting summary export: built in the host's tab, agents' words only.**
    - **What goes in:**
      - the date, and the time span the host's tab saw
      - who was there (agents labeled as agents, with owner and door)
      - agents' public answers, with whom each one answered
      - public task results (title, summary, details)
      - which agents kept notes
      - how often the agents paused
    - **What's left out:**
      - people's own chat lines
      - private answers: a new `private="1"` chat attribute from the bridge, and lock-prefixed messages from older bridges
      - anything whose sender, owner, `reply_to` or `sources` opted out of notes (the rule in `connector-queue.ts:189-197`)
      - filler lines
      - the meeting link, its slug and internal identities
    - **Where it lives:** only in the host tab's memory; a reload loses it. The host gets a header button and, after Leave, a "Download / Copy / Discard" screen.
    - **A real summary** comes from agents: if someone asks an agent to sum up the meeting, its answer is in the file.
    - **Alternatives:**
      - Add people's chat lines behind a host policy and a banner. That is close to a transcript, which PRD:49 rules out.
      - A server endpoint. The server has no chat, and storing it would break "nothing persists".

11. **Distribution: PyPI for the bridge, GHCR for the web image (both need your go-ahead).**
    - **Bridge:** `mooz-agent` goes to PyPI through trusted publishing; the name was free on 2026-10-20. The command the UI shows (`mooz-agent connect CODE --server …`) then works after `uv tool install mooz-agent`.
    - **Web image:** published to GHCR so a small VPS doesn't have to run `next build`.
    - **Alternative:** no registries. Use `uvx --from "git+https://github.com/Kainoa00/mooz@v0.1.0#subdirectory=bridge" mooz-agent …`, and build the image on the VPS.

12. **Demo and release gate.**
    - **README demo:** recorded with Playwright in offline mode (`MOOZ_PROVIDERS=fake`: the real bridge with a scripted brain), host and guest side by side.
      - Published as a GIF of at most 5 MB plus screenshots.
      - Captioned "Offline demo: scripted agent, no voice". Playwright video has no audio, and the offline agent is silent.
    - **Voice demo video:** you record it (your keys, your voice and face or people who agree) and upload it.
    - **v0.1.0 is tagged only after:**
      - CI is green on the close commit
      - one live ElevenLabs bridge run, with latency numbers
      - one live VoiceStudio run in Chrome and Firefox
      - one fresh VPS install from the guide, timed
    - **Alternative:** tag once CI is green and list what's unverified in the release notes.

## Patterns to Mirror
| Category | Source | Pattern |
|---|---|---|
| Provider seam | `bridge/src/mooz_agent/providers/base.py`, `providers/__init__.py` `build_providers` | Protocols for STT/TTS, choice from env and config, fakes for tests |
| Bridge HTTP | `bridge/src/mooz_agent/claim.py`, `tests/test_claim.py` | httpx client, errors mapped to readable messages, respx mocks |
| Audio out | `bridge/src/mooz_agent/speaking.py` `_speak` | Resample anything that isn't 48 kHz; `aclose()` on barge-in |
| Shared cases | `bridge/tests/text_cases.json` (M5) | One JSON file run by pytest and Vitest |
| Browser voice | `apps/web/lib/voice/elevenlabs.ts`, `speaker.ts`, `pcm.ts` | localStorage settings with try/catch; `PcmReader` playback at 24 kHz |
| CSP | `apps/web/lib/csp.ts` `livekitOrigins`, `csp.test.ts` | Named origins only, exact-list test, no bare schemes |
| Rate limits | `apps/web/lib/rate-limit.ts` `allow`, `app/api/connectors/route.ts:42-45` | Purpose-keyed windows, 429 `rate_limited`, injectable `now` |
| Lazy cleanup | `apps/web/lib/connector-agents.ts` `pruneConnectors(db, now)`, `connector-queue.ts` sweep (60 s) | Throttled sweep on use, testable clock |
| Schema | `apps/web/lib/db.ts` `MIGRATIONS` | Append-only migrations, `PRAGMA user_version` |
| Owner-side withdraw | `apps/web/lib/connector-agents.ts` `withdrawConnector` | Owner cookie, revoke plus kick |
| E2E fakes | `apps/web/e2e/agent-connector.spec.ts:165-202` | `page.route` fakes with CORS and OPTIONS answered |
| E2E bridge | `apps/web/e2e/fixtures.ts` `bringAgent` | Real bridge with `MOOZ_PROVIDERS=fake` |

## Files to Change
| File | Action | Why |
|---|---|---|
| `bridge/src/mooz_agent/gate.py`, `bridge/tests/gate_cases.json`, `bridge/tests/test_gate.py`, `apps/web/lib/voice/gate.ts` (+ test) | CREATE / UPDATE | One speech gate in two languages, shared cases |
| `bridge/src/mooz_agent/providers/local.py`, `providers/__init__.py`, `providers/base.py`, `config.py`, `cli.py`, `agent.py` | CREATE / UPDATE | OpenAI-compatible STT/TTS, provider choice, preflight, latency summary |
| `bridge/tests/test_local_voice.py`, `tests/test_providers.py`, `tests/test_cli.py`, `tests/live/test_local_speech_live.py` | CREATE / UPDATE | Unit tests with respx; opt-in live round trip |
| `bridge/.env.example`, `bridge/pyproject.toml` | UPDATE | Local voice variables; `live` marker text |
| `apps/web/lib/voice/settings.ts`, `lib/voice/local.ts`, `lib/voice/pcm.ts`, `lib/voice/scribe.ts`, `lib/voice/speaker.ts`, `lib/voice/elevenlabs.ts` | CREATE / UPDATE | Provider-neutral settings, local client, generic transcriber hub, WAV encoder |
| `apps/web/components/ConnectorVoice.tsx`, `ConnectorAgent.tsx` | UPDATE | Provider choice, Test button, status text that names the provider |
| `apps/web/lib/csp.ts`, `csp.test.ts` | UPDATE | Loopback HTTP in `connect-src` |
| `apps/web/e2e/connector-local-voice.spec.ts` | CREATE | Fake local server: request shapes, no key sent |
| `apps/web/app/api/rooms/route.ts`, `[slug]/join/route.ts`, `api/agent/claim/route.ts`, `api/agent/claim/[id]/route.ts`, small-body routes, `docker-compose.yml` | UPDATE | Rate limits, row cap, 4 KB body caps, env pass-through |
| `apps/web/lib/db.ts`, `lib/cleanup.ts` (+ test), `lib/rooms.ts`, `lib/agents.ts`, `app/api/livekit/webhook/route.ts` | CREATE / UPDATE | Expiry and activity columns, cleanup, session expiry |
| `apps/web/app/api/rooms/[slug]/my-agent-requests/**`, `components/MyAgentRequests.tsx`, `BringAgentDialog.tsx` | CREATE / UPDATE | Owners see and cancel requests made with their codes |
| `bridge/src/mooz_agent/room.py`, `agent.py` | UPDATE | `private="1"` chat attribute |
| `apps/web/lib/meeting-record.ts`, `lib/meeting-summary.ts` (+ tests), `components/MeetingRoom.tsx`, `ChatPanel.tsx`, `TaskPanel.tsx`, `components/MeetingSummary.tsx`, `e2e/meeting-summary.spec.ts` | CREATE / UPDATE | Summary export |
| `deploy/compose.yaml`, `deploy/livekit.yaml`, `deploy/Caddyfile`, `deploy/.env.example`, `docs/deploy-vps.md` | CREATE | Production kit and guide |
| `apps/web/lib/config-check.ts`, `apps/web/instrumentation.ts`, `apps/web/app/api/ready/route.ts`, `apps/web/Dockerfile`, `.dockerignore`, `livekit.yaml`, `.env.example` | CREATE / UPDATE | Startup checks, readiness, image hygiene, LiveKit v1.13.10 |
| `.github/workflows/ci.yml`, `.github/workflows/release.yml` | UPDATE / CREATE | Image build and smoke test; least-privilege permissions; tag release |
| `bridge/src/mooz_agent/__init__.py`, `cli.py`, `claim.py`, `bridge/README.md`, `bridge/LICENSE`, `scripts/check-version.mjs`, `CHANGELOG.md`, `SECURITY.md`, `apps/web/lib/connector-queue.ts` | CREATE / UPDATE | Versions, packaging, `.env` discovery, https-only server, round-trip metric |
| `apps/web/demo/playwright.demo.config.ts`, `apps/web/demo/demo.spec.ts`, `scripts/demo-gif.sh`, `docs/media/*` | CREATE | Recorded offline demo |
| `README.md`, `docs/local-voice.md`, `docs/protocol.md`, PRD | UPDATE / CREATE | Docs, PRD:73 closed, backlog ticked, status |

## Tasks
Every task follows the same rhythm:
1. Write the tests first.
2. Write the code.
3. Make one conventional commit.
4. Merge into `main` and push `main` (the CLAUDE.md workflow).

Anything outward-facing beyond pushing `main` is marked **[needs your go-ahead]**.

### Task 1: One speech gate for the bridge and the tab
- **Action**:
  - Give `SpeechGate` (`gate.ts`) options: `{ level, preRollMs, hangoverMs, maxUtteranceMs, minSpeechMs }`.
    - The defaults stay Scribe's: 0.008 RMS, 600 ms pre-roll, 1500 ms hangover.
    - Add `LOCAL_GATE` for batch transcription: 700 ms hangover, a forced cut at 15 s, and utterances under 300 ms of speech dropped.
    - Durations come from sample counts, so frame size doesn't matter.
  - Port the gate to `bridge/src/mooz_agent/gate.py`: RMS with numpy on int16 frames at 16 kHz.
  - Write `bridge/tests/gate_cases.json`: sequences of frame levels, and the sends and commits each should produce. Both pytest and Vitest run it.
- **Validate**: pytest and Vitest pass on the shared cases; the existing gate and Scribe tests pass unchanged.

### Task 2: Local voice in the bridge
- **Action**:
  - Add `providers/local.py` with `LocalSTT`:
    - It runs the gate, builds the WAV with `rtc.combine_audio_frames(...).to_wav_bytes()`, POSTs it, and yields the text.
    - A failed utterance (4xx, 5xx, refused connection, 30 s timeout) is logged at most once a minute per kind and skipped. It is never raised, so one bad request doesn't trigger the Listener's backoff and give-up (`listening.py:60-79`).
    - At most `MOOZ_STT_CONCURRENCY` (2) requests are in flight per bridge.
    - Audio buffers are dropped after the POST and never logged.
    - Empty text is dropped. So are known silence phrases ("Thank you.", "Thanks for watching!") on utterances under 1.5 s.
  - Add `LocalTTS` in the same file:
    - It splits the text into sentences and POSTs each one inside `async with client.stream(...)`.
    - `pcm` is cut into frames with `AudioByteStream` at `MOOZ_TTS_RATE`. `wav` takes its rate from the header and downmixes stereo.
    - The next sentence is requested while the current one plays. `aclose()` (barge-in) closes the response and cancels that request.
    - `warm()` caches "Yes?" and the filler line at connect.
  - One `httpx.AsyncClient` belongs to the providers and is closed when `run()` exits.
  - Choosing a provider:
    - `build_providers` picks `config.voice_provider`, then `MOOZ_VOICE`, then `elevenlabs`.
    - `MOOZ_BRAIN=offline` gives `OfflineModel` with real voice.
    - `check_environment(brain, voice)` asks for `ELEVEN_API_KEY` only for ElevenLabs.
  - `cmd_connect` checks local voice before joining:
    - It calls `GET {url}/models` with a 5 s timeout.
    - It refuses `MOOZ_SPEECH_API_KEY` with an `http://` URL to a host that isn't on this machine.
    - It warns on any non-loopback `http://` URL: "everyone's audio goes to <host> unencrypted".
  - Config and CLI:
    - `AgentConfig.voice_provider` is saved and loaded.
    - `init` gets `--voice-provider`, and the `--voice` help text no longer names ElevenLabs.
    - The `base.py:24` docstring says "mono, any rate".
  - Latency:
    - `Utterance` carries `speech_end_at` when the provider knows it.
    - Log "speech end → transcript" and keep "heard → voice".
    - At leave, log p50 and p95 for each, with the provider name.
  - Docs in code: list the variables in `bridge/.env.example`, and update the `live` marker text.
- **Validate**:
  - `tests/test_local_voice.py` with respx checks:
    - the multipart fields and a 16 kHz mono WAV header
    - `Authorization` sent only when a key is set
    - pcm chunks split on odd byte boundaries becoming 24 kHz frames
    - the wav header rate honoured, and stereo downmixed
    - `aclose()` mid-stream closing the request
    - error paths skipping without raising
    - sentences going out in order
  - Selection and `check_environment` tests; update the message asserted at `test_cli.py:27`.
  - Opt-in `tests/live/test_local_speech_live.py`, gated on `MOOZ_LIVE_TESTS=1` and `MOOZ_LOCAL_SPEECH_URL`: speak "Hello from mooz", resample to 16 kHz, transcribe, expect "hello". It logs time to first byte for speech and the transcription time.

### Task 3: Local voice in the connector tab
- **Action**:
  - Add `lib/voice/settings.ts`:
    - `VoiceSettings = { provider: "elevenlabs", apiKey, voiceId } | { provider: "local", baseUrl, voice, ttsModel, sttModel }`.
    - It keeps the `mooz.voice` key. Saved objects without `provider` read as ElevenLabs, so current users keep their voice.
    - `TTS_RATE`, `VoiceError` and the store move here, so `speaker.ts` and `scribe.ts` stop importing `elevenlabs.ts`.
    - Local rules:
      - `http:` only, host `127.0.0.1` or `localhost`, an explicit port
      - a path of `[A-Za-z0-9/_.-]` only; no credentials, query or fragment
      - voice `^[A-Za-z0-9._:-]{1,64}$`
      - models `^[A-Za-z0-9._:/-]{1,100}$` (Speaches model ids contain slashes)
  - Add `lib/voice/local.ts`:
    - `testLocal` does `GET /models`. If that fails, a second `mode: "no-cors"` probe tells "can't reach it" apart from "it answered but doesn't allow this page".
    - `synthesizeLocal` POSTs JSON to `/audio/speech` with `response_format: "pcm"` (24 kHz). It returns one stream, so `AgentSpeaker` and `PcmReader` work unchanged.
      - As in the bridge, it sends one sentence per request and asks for the next once the first audio arrives. `LocalVoiceOut` makes "Yes?" and the filler ahead of time.
      - It sends no `stream_format` field: strict servers reject unknown fields, and `audio` is the default anyway.
      - Each request, including reading its body, gets 60 s.
    - `transcribeLocal` POSTs a multipart WAV with `language: "en"` and `response_format: "json"`.
    - Errors become a `VoiceError` that says how to fix it:
      - "Can't reach your speech server at …. Is it running? If your browser asked about apps on this device, allow it in site settings."
      - "Add <this origin> to OMNIVOICE_ALLOWED_ORIGINS."
  - Hearing:
    - Pull a `Transcriber { send(pcm, commit); close() }` interface out of `ScribeHub` (`scribe.ts:221`).
    - `LocalUtterances` buffers gated frames with `LOCAL_GATE`, encodes a WAV (`wavBytes` in `pcm.ts`), and sends it through a per-tab queue (`LocalHearing`): 1 in flight, at most 6 waiting, oldest dropped.
    - The hub becomes `HearingHub` in `lib/voice/hearing.ts`.
    - When hearing stops:
      - at once for a wrong address or a refused page (401/403/404/405)
      - after 5 failures in a row for anything else
    - `ConnectorHearing` picks the transcriber by provider, and `openSpeaker` picks the synthesizer.
  - `useVoiceSettings` snapshots JSON. Everything keyed on `settings.apiKey` switches to `voiceKey(settings)`: `ConnectorAgent.tsx:124-130, 340, 354` and `ConnectorVoice.tsx:239, 271`.
  - The form:
    - The owner picks "ElevenLabs" or "Local speech server". Local has address and voice fields, with the models under "More".
    - Saving runs **Test**, after a line explaining the browser's prompt.
    - On an HTTPS page in Safari or iOS, the local option says why it can't work there.
    - The status line names the provider (`ConnectorAgent.tsx:466-469`).
  - CSP:
    - `LOCAL_VOICE_ORIGINS = ["http://127.0.0.1:*", "http://localhost:*"]` joins `connect-src`.
    - Update the exact list in `csp.test.ts`, and add guards against bare `http:`, `ws:` and `wss:`.
- **Validate**:
  - Vitest covers:
    - settings parsing, including old saved objects and hostile URLs
    - the WAV encoder
    - the local client with a mocked fetch
    - queue limits
    - the CSP
  - New `e2e/connector-local-voice.spec.ts`:
    - It fakes `http://127.0.0.1:3900/v1/**` with `page.route`, answering CORS as `agent-connector.spec.ts:165-202` does.
    - It checks the request shapes, that no `Authorization` header is sent, and that the agent speaks and hears.
  - The ElevenLabs E2E passes unchanged.
  - Note: Playwright runs on `http://localhost`, so the browser permission prompt and Safari are live checks in Task 11.

### Task 4: Rate limits and small body caps (L5, part 1)
- **Action**:
  - Add the limits from decision 6. The claim limit runs before `BEGIN IMMEDIATE` (`agents.ts:93,117`).
  - Use a 4 KB `readJson` cap for small bodies: join, agent-request decisions, notes policy, notes opt-out, connectors, connector requests. Questions keep 256 KB.
  - Pass `MOOZ_ROOMS_PER_MINUTE`, `MOOZ_MAX_CONNECTORS` and `MOOZ_CONNECTORS_PER_MINUTE` through `docker-compose.yml`. Today they are silently ignored under Docker.
  - Document the limits in `docs/protocol.md`, section 1.
- **Validate**: route tests with an injected `now`: each 429, the 409 `room_full`, and 413 for the small caps.

### Task 5: Nothing left after the meeting; sessions expire (L5 part 2, H2)
- **Action**:
  - Migration 12 adds `rooms.last_active_at`, `rooms.host_expires_at` and `participants.expires_at`, backfilled from `created_at`.
  - `isHost` (`rooms.ts:50-56`) and `findParticipant` (`rooms.ts:95-109`) reject expired secrets.
    - A join (and a host rejoin) pushes the expiry 24 h out and updates `last_active_at`.
  - `requireBridgeAgent` (`agents.ts:277-314`) also needs the owner's session to be valid, and `token_issued_at` within 24 h.
  - New `lib/cleanup.ts`:
    - `endMeeting(db, slug)`, called on `room_finished`, deletes codes and requests, then participants. It runs in one transaction because foreign keys are on (`db.ts:96`).
    - `sweep(db, now)` runs at most once a minute from room creation and joins. It deletes expired codes, requests older than 24 h or whose owner's session expired, expired participants, and rooms idle for 30 days.
    - After a sweep that deleted rows, it runs `PRAGMA wal_checkpoint(TRUNCATE)`.
    - `PRAGMA secure_delete = ON` is set when the database opens.
  - Docs:
    - README and protocol.md say what is kept and for how long.
    - protocol.md also documents the webhook dependency (PRD:101). The PRD says it is documented there, but it isn't.
- **Validate**:
  - Vitest on an in-memory DB with an injected clock:
    - delete order with foreign keys on
    - an agent that is approved and still in a meeting survives the sweep
    - expiry boundaries and the sliding refresh
  - A webhook route test for `room_finished`.
  - The meeting and agent E2E specs still pass.

### Task 6: Owners see requests made with their codes (H6)
- **Action**:
  - Add the two routes from decision 9, rate-limited to 60 a minute per participant.
  - `withdraw` reuses the host-removal kick.
  - `BringAgentDialog` follows the code it showed, and `MyAgentRequests` (polling every 3 s) shows while any of the owner's requests is pending.
  - Document both routes in protocol.md.
- **Validate**:
  - Route tests: only my own requests; I can't withdraw someone else's; same-origin check; rate limit.
  - E2E in `agent-approval.spec.ts`: the owner sees "Atlas is waiting for the host" and cancels. The host's tray drops it, and the bridge gets `denied`.

### Task 7: Meeting summary export
- **Action**:
  - Bridge:
    - `room.send_chat` sets `private: "1"` whenever `to` is set, and private task reports get it too (`agent.py:694-697`).
    - Documented in protocol.md, Chat section.
  - Web, collecting the record:
    - `lib/meeting-record.ts` is a pure reducer for chat, tasks, joins and leaves, pauses and notes keepers. It snapshots labels when they arrive, because labels vanish once an agent leaves.
    - Lift one `useChat()` so `ChatPanel` and the record share it. A second `useChat` would miss earlier messages (components-core `chat.ts:218-239`).
    - The record lives in `MeetingRoom` above `LiveKitRoom`, so Leave doesn't wipe it (`MeetingRoom.tsx:102`).
  - Web, writing the file:
    - `lib/meeting-summary.ts` `toMarkdown(record)` applies the rules from decision 10.
    - Text is escaped with `flatten`/`stripInvisible` (`lib/text.ts`) plus Markdown escaping, so there are no links, images, HTML or fake headings.
    - Caps:
      - 4000 characters per answer
      - 2000 per task summary
      - 4000 per task details
      - 500 KB per file, with the oldest entries dropped first and a note saying so
    - The file is named `mooz-meeting-YYYY-MM-DD-HHMM.md`.
  - UI:
    - A host-only "Download summary" button in the header (`MeetingContext.isHost`).
    - After Leave, the host sees "You left. Download the meeting summary / Copy / Discard".
- **Validate**:
  - Vitest table tests:
    - private answers dropped, including the old lock prefix
    - the opt-out rule through `reply_to` and `sources`
    - filler lines dropped
    - no slug or identities in the file
    - `![x](https://…)`, `<img>` and `# heading` escaped
    - the caps
  - pytest for the `private` attribute.
  - E2E `meeting-summary.spec.ts`:
    - the host gets the file (`page.waitForEvent("download")`); a guest sees no button
    - an opted-out person's question, its answer and a private answer are absent
    - a public task result is present

### Task 8: Production kit and VPS guide (H1, H3, HSTS)
- **Action**:
  - `deploy/compose.yaml`: every service uses `network_mode: host` and `restart: unless-stopped`, with json-file logs capped at 10 MB × 3.
    - **caddy:** `caddy:2.11.7`.
    - **livekit:** `livekit/livekit-server:v1.13.10` with `--config /etc/livekit.yaml` and no `--dev`, plus `LIVEKIT_KEYS: "mooz: ${LIVEKIT_API_SECRET:?…}"`.
    - **web:** `ghcr.io/kainoa00/mooz-web:${MOOZ_VERSION:-0.1.0}` with a `build:` fallback, `env_file: .env`, `HOSTNAME=127.0.0.1`, `LIVEKIT_API_URL=http://127.0.0.1:7880`, `LIVEKIT_API_KEY=mooz` and a `/data` volume.
  - `deploy/livekit.yaml`:
    - `bind_addresses: [127.0.0.1]`
    - `rtc: {tcp_port: 7881, udp_port: 7882, use_external_ip: true}`
    - `turn: {enabled: true, udp_port: 3478}`
    - `room: {max_participants: 20}`
    - `webhook: {api_key: mooz, urls: [http://127.0.0.1:3000/api/livekit/webhook]}`
  - `deploy/Caddyfile`:
    - Sites `{$MOOZ_DOMAIN}` (with HSTS) and `{$LIVEKIT_DOMAIN}` (with `stream_close_delay 5m`).
    - No `log` directive, because connector secrets sit in `/mcp/<secret>` paths.
  - `deploy/.env.example`: the two domains, `LIVEKIT_URL=wss://livekit.example.com`, `MOOZ_PUBLIC_URL=https://meet.example.com`, and a secret placeholder.
  - Startup and readiness checks:
    - `lib/config-check.ts` checks the LiveKit config, the `MOOZ_PUBLIC_URL` rule and `devkey` off localhost.
    - `instrumentation.ts` runs it at startup in production and exits with a clear message.
    - `GET /api/ready` opens the DB and runs the same checks. It answers 200 `{ok:true}` or 503 `{ok:false}`, with details only in the logs.
    - `/api/health` stays as it is, since Playwright waits on it.
    - The server logs one line when the first verified webhook arrives.
  - Image:
    - `.dockerignore` adds `**/.env*` (keeping `!**/.env.example`), `**/data` and `**/*.db*`.
    - The Dockerfile gets OCI labels (`org.opencontainers.image.source`, `licenses=MIT`, `version`).
    - It also gets a `HEALTHCHECK` that uses `node -e` with fetch on `/api/ready`, since the slim image has no curl.
    - Pin `node:22-slim` by digest.
  - Dev `docker-compose.yml`: LiveKit v1.13.10; `LIVEKIT_NODE_IP` documented in `.env.example`; still `--dev` and loopback only.
  - Bridge: refuse `--server http://…` unless the host is on this machine, with `--allow-http` for LAN testing. The claim secret is a Bearer token (`claim.py:58-89`).
  - CI:
    - A new `image` job builds the Dockerfile and runs it with a strong secret and a `wss` `LIVEKIT_URL`. It checks `/api/ready` returns 200, `/mooz-pcm-worklet.js` is served and the CSP header is present.
    - A second run with a weak secret must exit non-zero.
    - ci.yml gets `permissions: contents: read`.
  - `docs/deploy-vps.md` covers:
    - what you need
    - DNS: A/AAAA records for both names
    - firewall: open 22/tcp, 80/tcp, 443/tcp and udp, 7881/tcp, 7882/udp, 3478/udp; never 7880 or 3000; remember IPv6
    - secrets, in a `.env` with chmod 600
    - starting it
    - a verify list:
      - `ss -lntup` shows 7880 and 3000 on 127.0.0.1 only
      - a phone on mobile data gets media
      - Firefox works
      - the webhook log line appears
    - what bridge and connector owners need
    - local voice on a VPS meeting
    - backups (`VACUUM INTO` through node:sqlite inside the container, plus `.env` kept separately)
    - upgrades (between meetings; back up first)
    - one web instance only
    - sizing (estimate, plus the `lk load-test` command)
    - optional per-IP limits
    - the untested caddy-l4 TURN-over-TLS appendix
- **Validate**:
  - Vitest for `config-check` and `/api/ready`.
  - `docker compose -f deploy/compose.yaml --env-file deploy/.env.example config` passes.
  - The CI `image` job passes.
  - pytest for the http refusal.
  - The real VPS run is a live check in Task 11.

### Task 9: Release prep (versions, packaging, workflow)
- **Action**:
  - Versions:
    - `__version__` comes from `importlib.metadata`, and the CLI gets `mooz-agent --version`.
    - `scripts/check-version.mjs` checks that `apps/web/package.json`, `bridge/pyproject.toml`, `apps/web/lib/mcp.ts:89`, the top `CHANGELOG.md` entry and the tag (if any) all agree. CI runs it.
  - Bridge package:
    - `.env` is read from the current directory, then `$MOOZ_HOME/.env` (`~/.mooz/.env`). Today `load_dotenv()` at `cli.py:243` searches from the module's folder.
    - Update the error text at `providers/__init__.py:35-37`.
    - Add `bridge/LICENSE`, and make `bridge/README.md` the PyPI page (install, connect, local voice, absolute links).
    - pyproject gets authors, URLs, keywords and Python classifiers for 3.11–3.13.
    - CI runs the bridge unit tests on 3.11 and 3.13.
  - The code dialog shows an install line under the command: `uv tool install mooz-agent`, or the git form if decision 11 says no PyPI.
  - Connector round trip (PRD:25): `answerQuestion` logs `connector round trip <ms>`, with no content.
  - `CHANGELOG.md` (Keep a Changelog): 0.1.0, unreleased, covering M1–M6, known limits and upgrade notes.
  - `SECURITY.md`: reports through GitHub private vulnerability reporting; 0.1.x supported.
  - `.github/workflows/release.yml`, which does nothing until a `v*` tag is pushed:
    1. Re-runs CI through `workflow_call`.
    2. Checks the version against the tag.
    3. Builds the package with `uv build`.
    4. Builds the image for amd64 and arm64 and pushes it to GHCR.
    5. Publishes to PyPI through trusted publishing.
    6. Creates the GitHub Release with the CHANGELOG section and the wheel and sdist.
    - Publishing jobs run in GitHub environments (`pypi`, `release`) that need your approval click.
    - Actions are pinned by SHA.
    - Permissions per job: `id-token: write` only for PyPI, `packages: write` only for the image, `contents: write` only for the release.
    - `workflow_dispatch` publishes to TestPyPI as a dry run.
- **Validate**:
  - The wheel built by `uv build` has a License-File and the README.
  - `uvx --from bridge/dist/<wheel> mooz-agent --version` prints 0.1.0.
  - pytest for `.env` discovery and `--version`.
  - `check-version.mjs` passes, and fails on a planted mismatch.

### Task 10: README, docs and the demo
- **Action**:
  - README:
    - a status line saying what is live-verified and what isn't
    - the demo GIF at the top
    - a fixed quickstart: Docker only for the server, uv for the bridge, and "open http://localhost:3000 in your browser" in place of macOS-only `open`
    - "Try it without keys" (`MOOZ_PROVIDERS=fake`) and a local voice section
    - the VPS guide link in place of "A production guide comes with M6"
    - the Security text updated for loopback in the CSP
    - a short known-limits list, upgrade notes, a CI badge, and the M6 roadmap row
  - `docs/local-voice.md`:
    - a VoiceStudio how-to (install separately, `OMNIVOICE_ALLOWED_ORIGINS`, engines, GPU or Apple Silicon, CPU "10–50x slower")
    - bridge and tab settings
    - a browser table
    - troubleshooting: the prompt was denied; the origin isn't allowed; the server is asleep (VoiceStudio unloads its speech model after 900 s idle and takes about 8 s to reload)
    - other servers, and privacy
    - the measured numbers from the Task 2 live test
  - `docs/protocol.md`: the limits, `private`, the owner request routes, cleanup and expiry, and a changelog entry.
  - Demo:
    - `apps/web/demo/playwright.demo.config.ts`: video on, 1280×720, not part of CI.
    - `demo/demo.spec.ts` runs these beats:
      1. Create a meeting; a guest joins by link.
      2. Bring my agent; the host approves; the agent tile shows its badge.
      3. `@Atlas read plan.md from project`.
      4. A mention that doesn't wake the agent.
      5. A background task in the panel.
      6. A second agent, the floor strip, the pause and Continue.
      7. The host downloads the summary.
    - `pnpm -C apps/web demo:record`, then `scripts/demo-gif.sh` (ffmpeg side by side, palette) writes `docs/media/demo.gif` (at most 5 MB) and PNG screenshots (at most 300 KB each).
  - PRD:
    - close PRD:73 with the browser answer, and add the Safari risk
    - tick H3, H4 and H5 (done in M4), and the items done in Tasks 4–8
    - remove the participant-rows limit (PRD:103), and add known limits after M6
- **Validate**:
  - The demo spec passes locally, and the script enforces the size budgets.
  - The full suite passes.

### Task 11: Gates, live checks, release, close
- **Action** (in this order):
  1. Run `security-reviewer` on Tasks 2–9. Focus:
     - the CSP widening, and how local voice URLs are checked
     - API keys over http
     - cleanup order and session expiry bypasses
     - lockouts from server-wide limits
     - who may withdraw a request
     - export leaks (private or opted-out content) and Markdown injection
     - deploy ports and secrets
     - release workflow permissions

     Run `code-reviewer` on the milestone diff. Fix every finding and re-review. Commit, merge into `main`, push `main`, and wait for green CI.
  2. Live checks (you; they need your keys, a VPS and a domain):
     - an ElevenLabs bridge run with latency p50 and p95 (PRD:24)
     - VoiceStudio with the bridge
     - VoiceStudio from the tab on an HTTPS VPS page in Chrome and Firefox; confirm that Safari blocks it
     - a fresh VPS install from the guide, timed from clone to first meeting (PRD:26, target under 10 minutes)
     - two real agents (M5)
     - the connector apps (M4)
     - ElevenLabs concurrent streams for 6 people (PRD:74)
  3. Close commit: date the CHANGELOG entry; mark M6 complete in the PRD with the live-check status; update the README status. Merge, push `main`, and wait for green CI.
  4. **[needs your go-ahead]** one by one:
     - a TestPyPI dry run
     - push tag `v0.1.0` on the green close commit
     - approve the `pypi` and `release` environments
     - make the GHCR package public
     - check the GitHub Release
     - fix the repo description; today it says agents "talk as if it were another person", which breaks the "never passed off as human" rule
     - add topics and a homepage
     - upload your voice demo and link it from the README in a follow-up commit
- **Validate**:
  - CI is green on the tagged commit, and the release workflow is green.
  - `uvx mooz-agent --version` prints 0.1.0 from PyPI.
  - `docker pull ghcr.io/kainoa00/mooz-web:0.1.0` works without logging in.
  - A VPS install works from the published image.

### What needs your go-ahead
| Step | Where | Can it be undone? |
|---|---|---|
| Push `main` after each task | GitHub (public repo) | Standing rule in CLAUDE.md |
| Turn on private vulnerability reporting (for SECURITY.md) | Repo settings | Yes |
| Create PyPI and TestPyPI pending publishers for `mooz-agent`, and the `pypi`/`release` environments | pypi.org, repo settings | Yes, until the first upload |
| Push tag `v0.1.0` (starts `release.yml`) | GitHub | Tag yes; builds that already ran, no |
| Publish `mooz-agent 0.1.0` to PyPI | pypi.org | **No**: a version can never be re-uploaded |
| Push `ghcr.io/kainoa00/mooz-web:0.1.0` and make it public | GHCR | Yes (new packages start private) |
| Create the GitHub Release | GitHub | Yes |
| Change the repo description, topics and homepage | GitHub | Yes |
| Upload the voice demo video, and any announcement | GitHub or YouTube | Partly |

## Validation
```bash
pnpm -C apps/web lint && pnpm -C apps/web typecheck && pnpm -C apps/web exec vitest run --coverage
pnpm -C apps/web exec playwright test
cd bridge && uv run ruff check && uv run ruff format --check && uv run mypy && uv run pytest -m "not live" --cov --cov-fail-under=80
node scripts/check-version.mjs
docker compose -f deploy/compose.yaml --env-file deploy/.env.example config --quiet
# In CI (the dev sandbox can't reach npm): image build + smoke run
docker build -f apps/web/Dockerfile -t mooz-web:ci .
# Opt-in, needs a running speech server:
cd bridge && MOOZ_LIVE_TESTS=1 MOOZ_LOCAL_SPEECH_URL=http://127.0.0.1:3900/v1 uv run pytest -m live tests/live/test_local_speech_live.py
# On demand:
pnpm -C apps/web demo:record && scripts/demo-gif.sh
```

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| Local voice too slow on CPU (PRD:115). VoiceStudio sends no speech audio until it has synthesized the whole clip, and its first-audio time is unknown | High | One sentence per request; cached fixed phrases warm the model; GPU or Apple Silicon in the docs; measured numbers published; ElevenLabs stays the default |
| VoiceStudio refuses the tab because the mooz origin isn't in `OMNIVOICE_ALLOWED_ORIGINS` (setting it also replaces its defaults) | High | The Test button tells "unreachable" from "not allowed"; the error names the variable; the guide gives the full value |
| Safari and iOS can't reach loopback from HTTPS | Certain | Clear message; the bridge works everywhere; works from `http://localhost` pages |
| The browser prompt is denied or ignored, or a company policy blocks it silently | Medium | Prompt during setup (Test); re-allow steps per browser; chat still works |
| Whisper-style models invent text on silence ("Thank you."), causing false wakes or noise in transcripts | Medium | No name prompt; minimum length; silence-phrase filter on short clips; `@Name` in chat as the sure way |
| Each bridge transcribes everyone, so a local server gets up to 6 requests at once | Medium | 2 in flight per bridge, 1 per tab, 15 s cap; dropped clips are logged |
| OpenAI-compatible servers differ (pcm rate, `stream_format`, model and voice names) | Medium | Configurable rate and format (`wav` fallback); per-server table; VoiceStudio pinned at 0.5.7+ |
| Widening `connect-src` to loopback weakens "pages connect only to mooz, LiveKit, ElevenLabs" | Low | Loopback HTTP only, no `ws:`, nonce scripts unchanged; documented in README and CSP comment |
| Cleanup deletes rows still in use, or hits foreign keys | Medium | One transaction in the right order; tests with foreign keys on; only finished or expired rows |
| Session expiry signs someone out mid-meeting | Low | 24 h, reset on every join; LiveKit keeps them connected; rejoin restores it |
| A flood uses up a server-wide limit for everyone | Medium | Generous limits; per-room keys for joins; optional per-IP limits in Caddy |
| Without webhooks, presence and prompt cleanup don't happen | Medium | The sweep works anyway; the guide checks webhooks arrive; documented in protocol.md |
| Production config untested on a real VPS (TURN over UDP without a domain under 1.13.10's TURN validation is unknown) | High | CI image smoke; your timed VPS install before the tag; drop the `turn:` block if LiveKit refuses it |
| No TURN over TLS on 443, so networks that only allow 443 get no media | Medium | ICE over TCP 7881 and TURN over UDP 3478; caddy-l4 appendix (untested) |
| LiveKit 1.13.7 → 1.13.10 changes media server and TURN internals | Low | Full CI E2E plus the VPS check |
| Old bridges' private replies to the host look public in the export | Low | Lock-prefix fallback; documented |
| The demo is mistaken for real AI output or voice | Low | "Offline demo: scripted agent, no voice" caption; real video from you |
| Releasing before voice was ever verified live | Medium | Release gate (decision 12) |
| OpenAI shuts down its classic audio models (Jan–Feb 2027) and local servers drift | Low | Local servers are the target; versions pinned in docs |

## Acceptance
- [ ] All tasks complete, each a conventional commit merged to `main`
- [ ] Validation passes in CI, coverage at 80% or higher for web and bridge; the Docker image builds and passes its smoke run in CI
- [ ] A bridge agent hears and speaks through an OpenAI-compatible local server with no cloud voice key; ElevenLabs stays the default
- [ ] A connector agent uses a local speech server from the tab in Chrome, Edge and Firefox; Safari users get a clear message; the server never sees a voice key or audio
- [ ] The CSP adds only loopback HTTP to today's origins
- [ ] Rate limits on room creation, joins and claims; meeting rows deleted after meetings; sessions expire on the server; owners see and can cancel requests made with their codes; every PRD backlog box ticked
- [ ] The host's summary holds no person's own words, no private answers and nothing tied to an opted-out person
- [ ] PRD:73 closed with the browser answer
- [ ] README with the demo, `docs/deploy-vps.md`, `docs/local-voice.md`, CHANGELOG and SECURITY.md
- [ ] `security-reviewer` and `code-reviewer` gates passed, every finding fixed and re-reviewed
- [ ] Live checks (needs you): ElevenLabs latency, VoiceStudio in the bridge and tab, timed VPS install, two real agents, connector apps
- [ ] v0.1.0 tagged, published and released (needs your go-ahead)
