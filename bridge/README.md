# mooz-agent

Bring your own AI agent into a [mooz](https://github.com/kainoa00/mooz) meeting. It runs on
your machine with your keys, joins the meeting as `🤖 Your Name's Atlas` once the host approves
it, and answers by voice and in chat when someone says its name.

- **Your keys stay here.** The mooz server never sees your AI or voice keys. Everything the
  agent hears is sent only to the providers you chose (or to a speech server on this machine).
- **Always shown as an agent.** It can't pass itself off as a person or relabel itself.
- **Reads what you allow.** Folders and GitHub repos you add, read-only, with secrets files
  hidden. Only you get your private ones; everyone else gets only what you marked public.

## Install

You need Python 3.11 or newer. With [uv](https://docs.astral.sh/uv/):

```bash
uv tool install mooz-agent
```

Or `pipx install mooz-agent`. Check it with `mooz-agent --version`.

## Keys

Put them in `~/.mooz/.env` (readable only by you: `chmod 600 ~/.mooz/.env`) or in your
environment, which wins. A `.env` in the folder you run it from is never read: a project's own
could send your keys or everyone's audio somewhere else.

```bash
mkdir -p ~/.mooz && touch ~/.mooz/.env && chmod 600 ~/.mooz/.env
```

| Setting | For |
|---|---|
| `ANTHROPIC_API_KEY` | A Claude brain (the default) |
| `XAI_API_KEY` | A Grok brain (`mooz-agent init Atlas --brain grok`) |
| `ELEVEN_API_KEY` | ElevenLabs hearing and voice (the default) |
| `MOOZ_VOICE=local` and `MOOZ_SPEECH_URL` | A speech server on this machine instead of ElevenLabs, such as VoiceStudio at `http://127.0.0.1:3900/v1` (see [local voice](https://github.com/kainoa00/mooz/blob/main/docs/local-voice.md)) |
| `GITHUB_TOKEN` | Optional: GitHub repos you add (read-only; public repos work without one) |
| `MOOZ_HOME` | Optional: where agents live (default `~/.mooz`) |

The full list is in [`.env.example`](https://github.com/kainoa00/mooz/blob/main/bridge/.env.example).

## Join a meeting

In the meeting, click **Bring my agent → mooz-agent on my machine** and copy the command:

```bash
mooz-agent connect ABCD-EFGH-JKLM --server https://meet.example.com --name Atlas
```

The code works once and expires in 10 minutes. When the host approves, say **"Hey Atlas, …"**
or type **`@Atlas …`** in the chat. Ctrl-C takes it out.

No keys yet? `MOOZ_PROVIDERS=fake` runs an offline demo that understands a few fixed phrases.

## A personal agent

Set one up once, with the folders and repos it may read, then bring it to any meeting:

```bash
mooz-agent init Atlas --source ~/code/myapp --public-source ~/notes/team
mooz-agent sources add github:acme/site --agent Atlas
mooz-agent memory add "Our office is in Honolulu" --public --agent Atlas
mooz-agent connect ABCD-EFGH-JKLM --server https://meet.example.com --agent Atlas
```

Its settings and memory live in `~/.mooz/agents/atlas/`, never your keys. It can take notes
when the host allows and everyone is told, and research in the background ("Atlas, look into
why CI is flaky"). The [mooz README](https://github.com/kainoa00/mooz#your-personal-agent)
covers all of it, and what it costs.

> Anything the agent says, the whole meeting hears. Give it only folders you'd be comfortable
> having read out, and ask for private answers ("Atlas, privately, …") when it matters.

## Links

- [mooz](https://github.com/kainoa00/mooz): the meeting server, self-hosted
- [The bridge protocol](https://github.com/kainoa00/mooz/blob/main/docs/protocol.md), for agents
  in any language
- [Changelog](https://github.com/kainoa00/mooz/blob/main/CHANGELOG.md) and
  [security policy](https://github.com/kainoa00/mooz/blob/main/SECURITY.md)

MIT licensed.
