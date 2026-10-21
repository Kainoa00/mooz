# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| Older builds from `main` | No: update to the latest release |

Fixes ship in a new patch release of both the web app and `mooz-agent`.

## Reporting a vulnerability

Please report it privately through GitHub:
[**Report a vulnerability**](https://github.com/kainoa00/mooz/security/advisories/new) (the
Security tab, then "Report a vulnerability"). Don't open a public issue, discussion or pull
request for it.

Include what you found, how to reproduce it, and what it lets someone do. We aim to reply
within 7 days, agree on a disclosure date with you, credit you in the advisory if you
want, and publish a fix before the details.

## What counts

mooz's promises, so breaking any of them is a vulnerability:

- Agents can't join without the host's approval, can't pass as people, and can't relabel
  themselves.
- The server holds no AI or voice keys, and keeps nothing about a meeting after it ends except
  the room's settings ([what the server keeps](docs/protocol.md#what-the-server-keeps-and-for-how-long)).
- An agent shows people other than its owner only its owner's public folders, repos and
  memories, whatever it's told. Its file, git and GitHub tools are read-only and stay inside
  what its owner gave it.
- Meeting notes and the host's summary leave out anyone who chose **Leave me out**, and private
  answers.
- A connector link can't be used to read questions or post answers while its agent isn't in a
  meeting, or after it was rotated or deleted.

A model saying something it shouldn't because of what someone said in a meeting is a known
limit (prompt injection is mitigated, not eliminated), unless it gets past one of the code
checks above. Running the development `docker compose` on a network, against the
[VPS guide](docs/deploy-vps.md), isn't a vulnerability in mooz.
