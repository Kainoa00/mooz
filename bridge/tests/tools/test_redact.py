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
    assert out == "\n".join(["key:", *[REDACTED] * 4, "end"])  # line numbers still line up


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


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        (
            "DATABASE_URL=postgres://admin:hunter2pw@db.internal/prod",
            f"DATABASE_URL=postgres://admin:{REDACTED}@db.internal/prod",
        ),
        ("ADMIN_PIN=483920", f"ADMIN_PIN={REDACTED}"),
        ("authToken: abcd1234", f"authToken: {REDACTED}"),
        ("STRIPE_PRIVATE_KEY=abcd-efgh", f"STRIPE_PRIVATE_KEY={REDACTED}"),
        ("client_secret = 'zxcv'", f"client_secret = '{REDACTED}'"),
    ],
)
def test_redacts_more_secret_shapes(line: str, expected: str) -> None:
    assert redact(line) == expected


@pytest.mark.parametrize(
    "safe",
    [
        "sort_key = 'name_desc'",
        "PRIMARY_KEY = id",
        "PORT=8080",
        "mapping = 'abcd1234'",
        "TIMEOUT = 30",
        "token = self.session.token",
        "https://example.com/docs",
    ],
)
def test_keeps_ordinary_config_readable(safe: str) -> None:
    assert redact(safe) == safe


KEY_LINES = [
    "-----BEGIN RSA PRIVATE KEY-----",
    *["MIIEow" + "A" * 58] * 3,
    "pWQx9==",
    "-----END RSA PRIVATE KEY-----",
]


def test_a_whole_key_keeps_the_line_count() -> None:
    text = "before\n" + "\n".join(KEY_LINES) + "\nafter"
    out = redact(text)
    assert out.count("\n") == text.count("\n")
    assert "MIIEow" not in out and "pWQx9" not in out
    assert out.startswith("before\n") and out.endswith("\nafter")


def test_part_of_a_key_is_still_redacted() -> None:
    middle = "\n".join(KEY_LINES[2:])  # a line range starting past BEGIN
    opened = "\n".join(KEY_LINES[:3])  # truncated before END
    for out in (redact(middle), redact(opened)):
        assert "MIIEow" not in out and "pWQx9" not in out


def test_long_base64_lines_are_redacted_wherever_they_appear() -> None:
    line = "MIIEow" + "Ab9+/" * 14
    assert redact(f"+{line}") == f"+{REDACTED}"  # in a diff
    assert redact(line) == REDACTED
    assert redact("a normal sentence that happens to be long enough to be sixty chars") != REDACTED


def test_redaction_stays_fast_on_hostile_input() -> None:
    import time as _time

    for hostile in (
        "a." * 200_000,
        "a" * 400_000,
        "x=" * 200_000,
        "a://b:" * 70_000,
        "k='" * 130_000,
    ):
        start = _time.monotonic()
        redact(hostile)
        assert _time.monotonic() - start < 1.0


@pytest.mark.parametrize(
    "text",
    [
        "\r\n".join(KEY_LINES[2:]),  # CRLF file, BEGIN out of view
        "\n".join(f" -{line}" for line in KEY_LINES[1:]),  # combined diff
        "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBGX"
        + "a" * 60
        + "\n=AbCd\n-----END PGP PRIVATE KEY BLOCK-----",
    ],
)
def test_keys_in_other_shapes_are_redacted(text: str) -> None:
    out = redact(text)
    assert "MIIEow" not in out and "pWQx9" not in out and "lQOYBGX" not in out and "AbCd" not in out
