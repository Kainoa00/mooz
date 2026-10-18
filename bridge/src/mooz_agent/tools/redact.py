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
_NAME = r"\b[A-Za-z_]*(?:api[_\-]?key|secret|token|password|passwd|pwd)[A-Za-z_]*\b"
# NAME = "literal" or NAME: bareword. Code like `password = os.environ[...]` is left alone.
_QUOTED = re.compile(rf"(?i)({_NAME}\s*[:=]\s*)([\"'])([^\"'\s]{{8,}})\2")
_BARE = re.compile(rf"(?i)({_NAME}\s*[:=]\s*)([A-Za-z0-9_\-+/=.]{{8,}})(?=$|[\s,;])", re.MULTILINE)


def redact(text: str) -> str:
    text = _PRIVATE_KEY.sub(REDACTED, text)
    for pattern in _TOKENS:
        text = pattern.sub(REDACTED, text)
    text = _QUOTED.sub(lambda m: f"{m.group(1)}{m.group(2)}{REDACTED}{m.group(2)}", text)
    return _BARE.sub(lambda m: f"{m.group(1)}{REDACTED}", text)
