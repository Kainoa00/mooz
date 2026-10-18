"""Scrub secret-looking strings from anything the agent reads. Answers are spoken to a room."""

from __future__ import annotations

import re

REDACTED = "[redacted]"

_PRIVATE_KEY = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----", re.DOTALL
)
_TOKENS = [
    re.compile(p)
    for p in (
        r"\bsk-[A-Za-z0-9_\-]{20,}",  # Anthropic, OpenAI
        r"\bxai-[A-Za-z0-9_\-]{20,}",  # xAI
        r"\bgh[pousr]_[A-Za-z0-9]{30,}",  # GitHub tokens
        r"\bgithub_pat_[A-Za-z0-9_]{20,}",
        r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",  # AWS access keys
        r"\bxox[abprs]-[A-Za-z0-9\-]{10,}",  # Slack
        r"\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}",  # Stripe
        r"\bAIza[0-9A-Za-z_\-]{35}",  # Google API keys
        r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",  # JWTs
    )
]
# scheme://user:password@host -> keep the user, hide the password
_URL_CREDENTIALS = re.compile(r"(\b[a-zA-Z][a-zA-Z0-9+.\-]*://[^/\s:@]+:)([^@\s/]+)(@)")

# Identifier words that mark a value as secret. "key" only counts next to a qualifier,
# so sort_key or PRIMARY_KEY stay readable.
_SECRET_WORDS = frozenset(
    "password passwd passphrase pwd pass secret secrets token tokens apikey pin auth "
    "credential credentials cred creds dsn salt cookie privatekey".split()
)
_KEY_QUALIFIERS = frozenset("api access private secret signing encryption master".split())
_IDENT_PART = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+")

_ASSIGN_QUOTED = re.compile(r"(\b[A-Za-z_][A-Za-z0-9_.\-]*)(\s*[:=]\s*)([\"'])([^\"'\s]{4,})\3")
_ASSIGN_BARE = re.compile(
    r"(\b[A-Za-z_][A-Za-z0-9_.\-]*)(\s*[:=]\s*)([A-Za-z0-9_\-+/=.~!#$%^&*]{4,})(?=$|[\s,;])",
    re.MULTILINE,
)


def _is_secret_name(name: str) -> bool:
    parts = [p.lower() for p in _IDENT_PART.findall(name)]
    joined = "".join(parts)
    if any(p in _SECRET_WORDS for p in parts) or "apikey" in joined or "privatekey" in joined:
        return True
    return "key" in parts and any(p in _KEY_QUALIFIERS for p in parts)


def _looks_like_code(value: str) -> bool:
    # os.environ.get, settings.DB, self.token: references, not literals.
    head = value.split(".", 1)[0]
    return "." in value and head.isidentifier()


def redact(text: str) -> str:
    text = _PRIVATE_KEY.sub(REDACTED, text)
    for pattern in _TOKENS:
        text = pattern.sub(REDACTED, text)
    text = _URL_CREDENTIALS.sub(lambda m: f"{m.group(1)}{REDACTED}{m.group(3)}", text)

    def quoted(m: re.Match[str]) -> str:
        if not _is_secret_name(m.group(1)):
            return m.group(0)
        return f"{m.group(1)}{m.group(2)}{m.group(3)}{REDACTED}{m.group(3)}"

    def bare(m: re.Match[str]) -> str:
        if not _is_secret_name(m.group(1)) or _looks_like_code(m.group(3)):
            return m.group(0)
        return f"{m.group(1)}{m.group(2)}{REDACTED}"

    text = _ASSIGN_QUOTED.sub(quoted, text)
    return _ASSIGN_BARE.sub(bare, text)
