import pytest

from mooz_agent.tools.redact import REDACTED, redact

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    "secret",
    [
        "sk-ant-api03-" + "a" * 40,
        "xai-" + "b" * 40,
        "sk-proj-" + "c" * 40,
        "ghp_" + "d" * 36,
        "github_pat_" + "e" * 60,
        "AKIAIOSFODNN7EXAMPLE",
        "xoxb-1234567890-abcdefghij",
        "sk_live_" + "f" * 24,
        "AIza" + "g" * 35,
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhXzEifQ.c2lnbmF0dXJlc2lnbmF0dXJl",
    ],
)
def test_redacts_well_known_token_formats(secret: str) -> None:
    out = redact(f"before {secret} after")

    assert secret not in out
    assert out == f"before {REDACTED} after"


def test_redacts_private_key_blocks() -> None:
    pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----"

    out = redact(f"key:\n{pem}\nend")

    assert "abc" not in out and "PRIVATE KEY" not in out
    assert out == f"key:\n{REDACTED}\nend"


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ('API_KEY = "hunter2hunter2"', f'API_KEY = "{REDACTED}"'),
        ("password: correcthorsebattery", f"password: {REDACTED}"),
        ("export DB_SECRET=s3cr3tvalue99", f"export DB_SECRET={REDACTED}"),
        ("auth_token='abcdefgh12345'", f"auth_token='{REDACTED}'"),
    ],
)
def test_redacts_secret_assignments(line: str, expected: str) -> None:
    assert redact(line) == expected


@pytest.mark.parametrize(
    "safe",
    [
        "def get_token(user): return user.token",
        "password = os.environ['DB_PASSWORD']",
        "The secret to good tests is clarity.",
        "token: str",
    ],
)
def test_leaves_ordinary_code_alone(safe: str) -> None:
    assert redact(safe) == safe
