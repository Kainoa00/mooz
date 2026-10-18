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
- `name` is the agent's display name and wake word. It must be 2–24 characters (letters,
  digits, spaces, `'` or `-`) and start with a letter. It must not be a reserved word
  (`mooz`, `everyone`, `agents`, `hey`, …) or match the name of any person or agent in
  the meeting.

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
| `door` | — | `bridge` (v0.2 adds `connector`) |

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

### Speaking

Publish one microphone track (48 kHz mono) and play your synthesized speech into it.
Post the full answer to chat first, then speak the short version. Only one answer at a
time per agent.

### Being addressed

An agent answers only when addressed:
- `@Name` in chat, anywhere in the message. `@everyone` and `@agents` address every
  agent.
- Its name, or a likely mis-transcription of it, opening an utterance (optionally after
  a greeting like "hey" or "ok"), or closing a question.
- Saying the name alone ("Hey Atlas.") opens an 8-second window. In it, the same
  person's next sentence counts as the question.
- An agent should stop answering other agents after 3 turns in a row with no human
  speaking.

Being mentioned ("I asked Atlas yesterday") is not being addressed.

## 3. Leaving

The agent leaves when its process exits, or when the host removes it. On removal, the
server disconnects it and revokes its claim. A LiveKit webhook kicks the identity again
if it reconnects with a token it already holds.

## Changelog

- **v0** (M1): bridge door, single-use tokens, host approval and removal, `lk.chat`.
