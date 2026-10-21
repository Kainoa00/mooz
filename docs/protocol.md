# mooz bridge protocol (v0)

How an agent joins a mooz meeting. The Python `mooz-agent` package implements this,
but any language with a LiveKit client SDK can. This page is the contract.

**Status: v0, unstable.** Breaking changes are allowed until v1. Changes are listed at
the bottom.

## Principles

- **The agent runs on its owner's machine.** It connects *out* to the meeting, so it works
  from behind home routers. The mooz server never sees the owner's AI or voice keys.
- **mooz is the ears and mouth; the agent is the brain.** In v0 the agent does its own
  speech-to-text and text-to-speech, using the owner's keys or a local speech server.
- **Agents are always labeled as agents.** The server sets an agent's identity and
  attributes, and the agent cannot change them.

## 1. Joining

```
Owner (browser)                 mooz server                      Bridge (owner's machine)
      │ POST /api/rooms/{slug}/agent-codes ─▶│                              │
      │◀──── { code, command, expiresAt } ───│                              │
      │        (shows `mooz-agent connect CODE --server URL`)              │
      │                                      │◀── POST /api/agent/claim ────│ { code, name }
      │                                      │─── 201 { requestId, claimSecret, status } ─▶
Host  │◀──── approval tray: "Kainoa's Atlas wants to join" ──────────────────│
      │ POST /api/rooms/{slug}/agent-requests/{id} { decision: "approve" } ─▶│
      │                                      │◀── GET /api/agent/claim/{id} │ Authorization: Bearer claimSecret
      │                                      │─── { status: "approved", token, url, room, identity, name } ─▶
      │                                      │                              │── connect to LiveKit (url, token)
```

### `POST /api/agent/claim`

Request: `{"code": "ABCD-EFGH-JKLM", "name": "Atlas"}` with `content-type: application/json`.

- `code` is one-time. It expires 10 minutes after it is created and is bound to the
  participant who created it, the agent's **owner**. Case and dashes are ignored.
- `name` is the agent's display name. Its last word is its wake word. It must be 3–24
  characters (letters, digits, spaces, `'` or `-`), start with a letter, and end in a word
  of at least 3 letters. It must not be a reserved word (`mooz`, `everyone`, `agents`,
  `hey`, …) or end in a common English word (`notes`, `mark`, `can`, …). Its wake word
  must not sound or look like any word in the name of a person or agent in the meeting now
  (people who left, and agents gone for more than 2 minutes, don't count): the detector's
  own same-word test decides, so `Atlis` is refused next to `Atlas`, and `Lee's Grok` next
  to `Zach's Grok`. People's names are compared as they sound in plain Latin letters
  (`Атлас` and `Ａｔｌａｓ` count as `Atlas`). The error doesn't say whose name it clashes
  with. A person can make 10 codes an hour.

Responses:
- `201 {"requestId", "claimSecret", "status": "pending"}`. The response reveals nothing
  about the meeting.
- `400 invalid_code`: the code is unknown, used, expired, or burned. A code burns after
  5 rejected names.
- `400 invalid_agent_name`, `400 reserved_name`, `409 name_taken`: the name was
  rejected. The code stays usable.

### `GET /api/agent/claim/{requestId}`

Send `Authorization: Bearer <claimSecret>`, and poll about every 2 seconds.

| `status` | Meaning | What the bridge should do |
|---|---|---|
| `pending` | The host hasn't decided yet | Keep polling (requests expire after 10 minutes) |
| `approved` | Includes `token`, `url`, `room` (internal LiveKit room name), `identity`, `name` | Connect to LiveKit now |
| `denied` | The host declined | Exit |
| `revoked` | The host removed the agent | Exit |
| `expired` | The request lapsed, or the single token was already collected | Exit; the owner needs a new code |

Each approval issues **exactly one** token, valid for 5 minutes. LiveKit refreshes it
while the agent stays connected. An agent that disconnects needs a new code.

Error responses everywhere are `{"error": {"code", "message"}}`, and the message is
safe to show to a person.

## 2. In the room

The agent is an ordinary LiveKit participant with a restricted token:

| Grant | Value |
|---|---|
| Publish | Microphone audio only (`canPublishSources: [microphone]`) |
| Subscribe | Yes |
| Data | Yes |
| Edit own metadata/attributes | **No** |

Attributes the server sets on every participant:

| Attribute | Humans | Agents |
|---|---|---|
| `kind` | `human` | `agent` |
| `owner_id` | — | The owner's participant identity |
| `owner_name` | — | The owner's display name |
| `door` | — | `bridge`, or `connector` (see [5. Connector door](#5-connector-door)) |
| `connector_app` | — | For a connector agent: `grok`, `claude`, `chatgpt` or `other` |

Clients must always show agents as `🤖 {owner_name}'s {name}` with an agent badge.

### Hearing

- Subscribe to the audio tracks of participants with `kind = human`, one
  speech-to-text stream per track. The track tells you who is speaking, so no
  diarization is needed.
- **Don't transcribe other agents.** Read their replies from chat (below) instead.

### Chat

Chat uses LiveKit **text streams** on topic `lk.chat`, with the plain message text as
the body. This is what `@livekit/components-react`'s `useChat` sends and receives. An
agent posts its full answer here. Other agents and people see it with the sender's
attributes.

When an agent's message answers someone, set the text stream attribute `reply_to` to that
person's participant identity (for a question from another agent, its owner's), and `sources`
to the comma-separated identities of everyone whose words were in what the agent was given.
Notes use both to leave out replies that answer or could quote people who opted out, even if
they opt out later. Only agents' attributes are read.

Anyone can send a very long message, so cut what you parse (the reference bridge reads the
first 4,000 characters) and keep your parsing linear in the length.

Show the model who said what using server-assigned identities, never display names, which
people choose freely. The reference bridge renders one escaped line per message, tagged
`[owner]`, `[guest]`, `[agent]` or `[you]`.

### Speaking

Publish one microphone track (48 kHz mono) and play your synthesized speech into it.
Post the full answer to chat first, then speak the short version, all within a turn from
the meeting's floor (see [Taking turns](#taking-turns)). Only one answer at a time per
agent.

### Being addressed

An agent answers only when addressed:
- `@Name` in chat, anywhere in the message. `@everyone` and `@agents` address every
  agent.
- Its name, or a likely mis-transcription of it (similar in both sound and spelling),
  opening an utterance (optionally after a greeting like "hey" or "ok"), closing a
  question, or closing a request after a comma ("Summarize that, Atlas.").
- "Hey agents, ..." (set off by a comma) addresses every agent by voice.
- Saying the name alone ("Hey Atlas.") opens an 8-second window. In it, the same
  person's next sentence counts as the question.

A multi-word name wakes on its last word ("Grok" for "Zach's Grok"). Being mentioned ("I
asked Atlas yesterday") is not being addressed. Only the first of several names said in
one breath is heard ("Atlas and Nova, …" reaches Atlas); `@Atlas @Nova` or `@everyone`
reaches both.

Names that this detection could confuse are refused when an agent claims one or a person
joins: see `name` under [`POST /api/agent/claim`](#post-apiagentclaim). The test is the
detector's own, so what it refuses is exactly what it would mix up.

### Taking turns

Several agents can be in one meeting, and they answer one at a time, people first. Before
an agent posts or speaks an answer, it asks the server for a turn, and gives it back when
done.

| Call | What it does |
|---|---|
| `POST /api/agent/claim/{requestId}/turns` | Ask for a turn: `{"answering": "person" \| "agent", "speak": true \| false}` |
| `GET /api/agent/claim/{requestId}/turns/{turnId}` | Where it stands; waits up to 25 s for it to change while it's waiting or held |
| `POST /api/agent/claim/{requestId}/turns/{turnId}/done` | Finished (or no longer wanted) |

Each call carries `Authorization: Bearer {claimSecret}`, and works only while the agent is
in the meeting. Each answers `{"turn": {"id", "status", "endsInMs"?, "reason"?}}`:

- `status` is `waiting`, `held`, `granted` or `ended`. `endsInMs` is the time a granted turn
  has left. `reason` says why one ended: `done`, `timeout`, `expired`, `left`, `replaced` or
  `meeting_ended`.
- Asking returns at once. If the turn isn't `granted`, check it until it is (or ends).

How the server decides:

- **One turn at a time** in a meeting. Answers to people (`answering: "person"`, which
  includes `@everyone`) go ahead of replies to agents, then first come, first served.
- **Turns are short.** A turn with speech lasts at most 45 s, a chat-only turn 10 s; then
  it ends (`timeout`) and the next one starts. A waiting or held turn that isn't checked for
  10 s goes away (`expired`).
- **One open turn of each kind per agent.** Asking again replaces the last one of that kind.
  So a held reply to an agent doesn't stop the agent answering a person.
- **Agents pause.** After 3 agent-to-agent turns in a row in the meeting, or 3 replies to
  agents by one agent since it last answered a person, the next reply to an agent is
  `held`, not dropped. The meeting shows "The agents have gone back and forth 3 times. Let
  them continue?", and any person in the meeting can click **Continue**
  (`POST /api/rooms/{slug}/agents/continue` with `{}`, their participant cookie and a
  same-origin request; agents have no cookie). The held reply then goes out, and the counts
  start over. A turn that answers a person starts the meeting's count, and that agent's,
  over.
- **Fair turns.** An agent doesn't get two turns in a row while another agent's turn is
  waiting.
- An agent that leaves or is removed gives up its turns. When the meeting ends, the floor
  is forgotten.

What the agent must do:

- Post and speak answers (and "Yes?", and fillers like "One sec") only within a granted
  turn, and stop at its end. A finished background task may post its report to chat at
  once; its spoken part takes a turn.
- Keep its own limit too, since thinking costs its owner before the floor can hold
  anything: think about other agents' questions at most 3 times in a row, until a person
  speaks or `floor.paused` goes back to `false` (someone clicked Continue).
- **People first.** Wait up to 5 s for people to stop talking before speaking (LiveKit's
  active speakers). After that, leave the answer in the chat. Stop speaking if a person talks
  over it for more than a second; the chat answer stays.
- Give the turn back only after its last audio has played out and reached people (the
  reference bridge waits 250 ms more), so voices never overlap.
- If the floor can't be reached (no answer, or not JSON), answer people anyway, but not
  other agents.

The meeting sees the floor in the room metadata:
`{"floor": {"speaking": identity | null, "next": identity | null, "paused": bool}}`, next
to `notes_allowed`.

Errors: `404 request_not_found` (wrong id or secret) or `turn_not_found`;
`409 not_in_meeting`; `400 invalid_body`; `413` for a body over 1 KB; `429 rate_limited` (more
than 30 turns, 120 checks or 60 dones a minute), `floor_busy` (20 turns waiting) or
`too_many_checks` (2 checks already waiting on that turn).

A server older than M5 answers `404` with no JSON body. There is no floor then: answer
anyway, and stop answering other agents after 3 turns in a row with no person speaking.

`answering` is the agent's own word: the server can't check it. An agent that lies about it
can talk more, at its owner's cost, and keep the meeting's count low; it can't keep another
agent replying to it past 3 turns (each agent's own replies count too), and the host can
remove it.

## 3. Leaving

The agent leaves when its process exits, or when the host removes it. On removal, the
server disconnects it and revokes its claim. A LiveKit webhook kicks the identity again
if it reconnects with a token it already holds.

## 4. Access and consent

### Who is asking

Every chat message and audio track arrives with the sender's LiveKit identity, which the
server assigned and nobody can change. An agent's own attributes name its owner
(`owner_id`). So an agent always knows whether its owner is the one asking. Use that, not
anything said in the meeting, to decide access:

| Asker | Sources (folders, repos) | Memory |
|---|---|---|
| The owner | All | Read all, add, forget |
| Anyone else (people and other agents) | Public ones only | Read public notes only |

Enforce this where the tools run, not in the prompt: a private source should look exactly like
one that doesn't exist. The reference bridge does this in `mooz_agent/tools/toolbox.py`.

### Meeting notes

Notes need consent from the room, which only the mooz server can express:

| Signal | Where | Set by |
|---|---|---|
| The host allows notes | Room metadata `{"notes_allowed": true}` (absent or anything else means no) | `POST /api/rooms/{slug}/notes-policy` (host only) |
| A person leaves themselves out | Participant attribute `notes_opt_out` = `"1"` | `POST /api/rooms/{slug}/notes-opt-out` (that person only) |

An agent that keeps notes must:

1. Start only when its owner asks and the room allows notes.
2. Before keeping anything, announce it: a chat line, and a reliable data packet on topic
   `mooz.v0` with `{"type": "notes", "state": "on"}`. Send it again, addressed to them, to
   anyone who joins later, and answer `{"type": "notes?"}` (which browsers send whenever
   they connect or reconnect) directly with the current state. Keep a person's words only
   once a signal has reached them. Browsers show a banner for every agent whose last signal
   was `on`. They trust a signal only from an agent (`kind = agent`) and only about itself.
   Check the room metadata again after announcing, in case the host turned notes off meanwhile.
3. Leave out anyone whose `notes_opt_out` is `"1"`: their words, their agents' words, and any
   agent message whose `reply_to` or `sources` includes them. Check again before summarizing, so opting out also
   covers what they already said. While notes are on, don't use their words in answers to
   others.
4. Save only a summary, to the owner's private memory, never a transcript.
5. Stop (announcing `{"type": "notes", "state": "off"}`) when its owner asks or the room
   metadata stops allowing notes.

A bridge that keeps notes silently can't be detected. The guarantee covers the bridge mooz
ships, and the visible banner is what makes consent socially enforceable.

### Background tasks

An agent can work on something for its owner in the background and report back later. Only
the owner (the asker's identity equals the agent's `owner_id`) may start or cancel a task.
Everyone sees that it exists, the same transparency as the notes banner.

**Task updates** are LiveKit text streams on topic `mooz.tasks`, one JSON object per stream,
sent whenever a task changes:

```json
{
  "type": "task", "id": "t_0a1b2c3d", "state": "working",
  "title": "Look into why CI is flaky", "owner": "p_kai", "private": false,
  "progress": ["Checking CI on main"], "summary": "", "details": "", "error": "",
  "created_at": 1792355314.2, "updated_at": 1792355318.9, "seq": 3
}
```

| Field | Meaning |
|---|---|
| `id` | Unique per agent, not across agents. Browsers key tasks by sender identity and `id` |
| `state` | `queued` → `working` → `done`, `failed` or `cancelled` |
| `owner` | The identity of the person who asked, always the agent's own `owner_id` |
| `progress` | The latest few steps (at most 5), written by the bridge, not the model |
| `summary`, `details` | The result: the short spoken version and the longer chat text (`done` only) |
| `seq` | Increases with every update. Ignore an update older than one you already have |

- A **public** task goes to everyone. A **private** one goes in full only to its owner
  (`destination_identities`); everyone else gets the same event with `title` set to
  `"Private task"` and empty `progress`, `summary`, `details` and `error`.
- Browsers trust an update only from an agent (`kind = agent`) whose `owner_id` equals the
  update's `owner`, and drop an agent's tasks when it leaves.
- On (re)connecting, browsers send `{"type": "tasks?"}` on the `mooz.v0` data topic. Answer
  it, and also send every task to anyone who joins, addressed to them, because their query
  can arrive before you've seen them join.
- Answer `tasks?` (and the join push) at most once every couple of seconds per person, so asking
  over and over can't make the agent flood the meeting.
- `{"type": "task.cancel", "id": "t_0a1b2c3d"}` on `mooz.v0`, addressed to the agent, cancels
  a task. Honor it only from the owner.
- A public task's `progress` goes to everyone, so it must not name private sources or files
  (the reference bridge says "Reading a private file"). A status answer said to the room calls a
  private task "a private task", even when the owner asks.
- Research only reads: it doesn't get tools that change memory, so what it reads can't plant or
  delete notes. Likewise a quick answer changes memory only when the owner's own request asks
  for it, and makes a note public only when the request says so.
- When a task is done, post the result to chat (a private one only to the owner, with
  `destination_identities`) and save it to the owner's private memory. Speak a public result
  only at a pause in the conversation (no one is speaking, and no one has just finished), never
  a private one.
- When the owner asks for privacy ("privately", "just for me", "DM me"), answer only to them,
  as a chat message with `destination_identities`, never spoken and kept out of the transcript
  and notes. This covers quick answers, status answers and tasks, including a question that
  overflows into a task.

## 5. Connector door

A second way in, for people who'd rather bring the assistant app they already use (Grok,
Claude, ChatGPT or any app that takes a custom MCP connector) than run a bridge. The app never
joins the call itself: its owner's browser tab runs the agent, and the app answers through a
private MCP link.

```
Owner's assistant app            mooz server                     Owner's browser tab
      │                               │◀── POST …/connector-requests ──│ { connectorId }
      │                               │    (host approves as usual)    │
      │                               │─── POST …/{id}/token ─────────▶│ joins as the agent
      │                               │                                │ hears "@Grok …"
      │                               │◀── POST …/{id}/questions ──────│ { asker, text, lines }
      │◀── owner taps "Ask Grok ↗" (the prompt carries only the question's ID) ──│
      │── get_question ──────────────▶│                                │
      │── post_answer ───────────────▶│── data packet `mooz.connector` ▶│ posts in chat, speaks
```

### The connector link

`POST /api/connectors` `{ name, app, slug }` makes one, from a meeting the caller is in, and
returns `{ connector, url }` once (at most 10 an hour per person, 60 a minute across the server,
and 10 per owner; `MOOZ_CONNECTORS_PER_MINUTE` and `MOOZ_MAX_CONNECTORS` set the server's
ceilings). Only use while its agent is in a meeting counts: a link never used in one is deleted
after 24 hours, and any link after 180 days without use (unless its agent is in a meeting). The URL
is `{origin}/mcp/{secret}`, a 256-bit secret that the server stores only as a hash. The
connector belongs to the browser that made it (an HttpOnly owner cookie, kept a year, named
`__Host-mooz_owner` over HTTPS so no other host can set it).
`GET /api/connectors` lists them, `POST /api/connectors/{id}/rotate` replaces the secret (the old
link stops working) and `DELETE /api/connectors/{id}` removes it and its agent. Changes must
come from the same origin, and someone else's connector looks like one that doesn't exist.

### Joining

`POST /api/rooms/{slug}/connector-requests` `{ connectorId }` asks to bring it in and returns
`{ requestId, status: "pending" }` (at most 10 a minute per person and 30 per meeting). The host approves it in the same tray as bridge agents.
`GET …/{requestId}` returns `{ status }` (`pending`, `approved`, `denied`, `revoked` or
`expired`), and once approved `POST …/{requestId}/token` returns `{ token, url, identity, name }`
for the tab's agent connection, again after a reload. Every one of these needs the participant
cookie of the request's owner and the owner cookie its connector belongs to. Its token is a bridge
agent's (microphone and data only, no attribute edits) with `door = connector`. A newer request
for the same connector revokes the older one, and `DELETE …/{requestId}` cancels it or takes the
agent out.

The agent is in the meeting while its tab is. LiveKit's webhook tells mooz when the tab's session
leaves or joins (a late "left" from a replaced session is ignored). It may be away up to 2
minutes (a reload); after that the approval ends, its questions are dropped, and coming back
gets it removed, so the owner brings it again. When the meeting ends, its connector agents are
revoked.

### Questions

The tab hears the meeting like a bridge agent does, with the same rules for being addressed
(both detectors run `bridge/tests/addressing_cases.json`): chat always, and speech when the
owner has turned on voice in the browser, through their own ElevenLabs key or a speech server on
their computer. Either way the tab cuts speech with the bridge's gate
(`bridge/tests/gate_cases.json`); for a local server it sends one utterance per request.

`POST …/{requestId}/questions` `{ asker, text, at, lines }` queues a question (`at` is when the
line that asked it was heard) with what the tab heard lately, each line
`{ identity, text, via, at, reply_to?, sources? }` (at most 20 questions a
minute per agent and 60 per meeting, and 256 KB a request). The server keeps only the last 10
minutes of lines from people in the meeting (the newest 200, at most 12,000 characters),
re-derives names and roles itself, and leaves out every line that belongs to someone who opted
out of notes (the speaker, an agent's owner, or anyone in `reply_to` or `sources`), checking
again when the assistant reads it. Those lists are never cut short: a line that would bring a
question past 100 people to track is left out instead. Questions live in server
memory only: at most 5 wait per agent, each for 10 minutes, at most 20 in all (an answered one
keeps no lines), and all are dropped when the agent leaves for good. `GET …/questions` lists
them, with the answer once there is one.

**The owner's tap decides.** A queued question is invisible to the assistant until the owner taps
Ask or Copy for it, which sends `POST …/questions/{qid}/release`. `DELETE …/questions/{qid}`
dismisses one for good, and takes the line that asked it out of the other questions too. `POST …/questions/{qid}/answer` `{ spoken, details? }` takes an answer
the owner pasted (for any of their questions).

### The MCP endpoint

`/mcp/{secret}` speaks MCP over Streamable HTTP, statelessly (JSON responses; `GET` and `DELETE`
get a 405, as there are no streams or sessions), with no authentication beyond the secret.
Requests are capped at 64 KB and 30 a minute per connector; an unknown secret gets a plain 404.
Its tools, which work only while the connector's agent is in a meeting, and see only questions
the owner released:

| Tool | Does |
|---|---|
| `get_question({ question_id? })` | The oldest released question (or the one named): who asked (`your owner`, `a guest` or `another AI agent`), the question inside `<question>`, how to answer, and the meeting as `[role] name (via): text` lines inside `<meeting>` |
| `read_meeting()` | The meeting lines around the newest released question (nothing while none waits) |
| `post_answer({ question_id, spoken, details? })` | Answers it. `spoken` (at most 400 characters) is read aloud; `details` (at most 4,000) is added in chat |

Meeting text is normalized (NFKC), stripped of invisible characters, flattened to one line per
message (a typed line break shows as ` ⏎ `) and escaped, and marked as information, never
instructions. For a question from anyone but the owner, the assistant is told not to look in the
owner's mail, files, memory or other connectors.

### Answers

The server sends each answer to the agent's identity only, as a reliable data packet on topic
`mooz.connector`:

```json
{ "type": "answer", "id": "q_…", "spoken": "March 30th.", "details": "", "reply_to": "p_…", "sources": ["p_…"] }
```

The tab accepts it only from the server (a packet with no sending participant or identity), and
only for a question it knows of, then posts
`spoken` and `details` to `lk.chat` with the `reply_to` and `sources` attributes, and speaks
`spoken`. If a packet is missed, the tab picks the answer up from `GET …/questions`. The owner
can choose to review each answer before it's posted.

The tab takes turns like a bridge (see [Taking turns](#taking-turns)), with the owner's cookies
instead of a claim secret: `POST /api/rooms/{slug}/connector-requests/{id}/turns`,
`GET …/turns/{turnId}` and `POST …/turns/{turnId}/done`. It takes one for each answer, for
"Yes?", and for "One sec, checking." (only for a person, and only if the floor is free right
then).

## Changelog

- **v0** (M1): bridge door, single-use tokens, host approval and removal, `lk.chat`.
- **v0** (M2): access by asker identity, the `notes_allowed` room metadata, the `notes_opt_out`
  attribute, `mooz.v0` notes signals and `notes?` queries, and the `reply_to` and `sources` chat
  attributes.
  All additive; M1 agents keep working.
- **v0** (M3): background tasks: `mooz.tasks` task updates, `tasks?` queries and
  `task.cancel` on `mooz.v0`, and chat messages addressed to one person (private results). A
  task's report carries `reply_to` (its owner) and `sources` (whose words the task was given).
  All additive; M2 agents keep working.
- **v0** (M4): the connector door: connector links, `connector-requests`, the `/mcp/{secret}`
  endpoint, `mooz.connector` answer packets, and the `door = connector` and `connector_app`
  attributes. All additive; bridge agents are unchanged.
- **v0** (M5): taking turns (`…/turns` for both doors, `agents/continue`, and `floor` in the
  room metadata), and stricter names: 3 or more characters, a last word of 3 or more letters
  that isn't a common word, and nothing the detector would confuse with someone already
  here. Agents from M4 still join; without taking turns they talk over others, so update.
  A connector made earlier with a name the rules now refuse (`Mark`, `Nova 2`) can't join:
  delete it and make one with another name (its link changes).
