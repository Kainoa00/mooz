"""A personal agent's settings: who it is, which brain it uses, and what it may read."""

from __future__ import annotations

import os
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import tomli_w

Brain = Literal["claude", "grok"]
BRAINS: tuple[Brain, ...] = ("claude", "grok")
_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9' -]{1,23}$")
_LABEL = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")


class ConfigError(Exception):
    """The agent's configuration is missing or invalid."""


def agents_root() -> Path:
    return Path(os.environ.get("MOOZ_HOME", "~/.mooz")).expanduser() / "agents"


def _slug(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower().replace("'", "")).strip("-")
    return slug or "agent"


def agent_dir(name: str) -> Path:
    return agents_root() / _slug(name)


@dataclass
class Source:
    """A folder or repo the agent can read. Public sources are visible to anyone who asks."""

    label: str
    path: Path
    public: bool = False


@dataclass
class AgentConfig:
    name: str
    brain: Brain = "claude"
    model: str | None = None
    voice_id: str | None = None
    language: str = "en"
    sources: list[Source] = field(default_factory=list)

    @property
    def home(self) -> Path:
        return agent_dir(self.name)

    def validate(self) -> None:
        if not _NAME.match(self.name.strip()):
            raise ConfigError(
                "Agent names are 2-24 characters (letters, numbers, spaces, ' or -), "
                "starting with a letter"
            )
        if self.brain not in BRAINS:
            raise ConfigError(f"brain must be claude or grok, not {self.brain!r}")
        labels = [s.label for s in self.sources]
        if len(labels) != len(set(labels)):
            raise ConfigError("source labels must be unique")

    def visible_sources(self, *, owner: bool) -> list[Source]:
        return [s for s in self.sources if owner or s.public]

    def add_source(self, path: Path, *, label: str | None = None, public: bool = False) -> Source:
        folder = path.expanduser().resolve()
        if not folder.is_dir():
            raise ConfigError(f"{folder} does not exist or is not a folder")
        taken = {s.label for s in self.sources}
        if label is not None:
            label = _slug(label)
            if label in taken:
                raise ConfigError(f"A source called {label!r} already exists")
        else:
            base = _slug(folder.name)[:36] or "source"
            label, n = base, 2
            while label in taken:
                label, n = f"{base}-{n}", n + 1
        if not _LABEL.match(label):
            raise ConfigError(f"Invalid source label {label!r}")
        source = Source(label=label, path=folder, public=public)
        self.sources.append(source)
        return source

    def remove_source(self, label: str) -> None:
        before = len(self.sources)
        self.sources = [s for s in self.sources if s.label != label]
        if len(self.sources) == before:
            raise ConfigError(f"No source called {label!r}")

    def save(self) -> Path:
        self.validate()
        home = self.home
        home.mkdir(parents=True, exist_ok=True)
        home.chmod(0o700)
        data: dict[str, object] = {
            "name": self.name,
            "brain": self.brain,
            "language": self.language,
        }
        if self.model:
            data["model"] = self.model
        if self.voice_id:
            data["voice_id"] = self.voice_id
        data["sources"] = [
            {"label": s.label, "path": str(s.path), "public": s.public} for s in self.sources
        ]
        target = home / "agent.toml"
        tmp = target.with_suffix(".toml.tmp")
        tmp.write_bytes(tomli_w.dumps(data).encode())
        tmp.chmod(0o600)
        tmp.replace(target)
        return target

    @classmethod
    def load(cls, name: str) -> AgentConfig:
        path = agent_dir(name) / "agent.toml"
        if not path.exists():
            raise ConfigError(
                f"No agent called {name!r} yet. Create it with: mooz-agent init {name}"
            )
        try:
            data = tomllib.loads(path.read_text())
        except tomllib.TOMLDecodeError as err:
            raise ConfigError(f"{path} is not valid TOML: {err}") from err
        cfg = cls(
            name=str(data.get("name", name)),
            brain=data.get("brain", "claude"),
            model=data.get("model"),
            voice_id=data.get("voice_id"),
            language=str(data.get("language", "en")),
            sources=[
                Source(label=str(s["label"]), path=Path(s["path"]), public=bool(s.get("public")))
                for s in data.get("sources", [])
            ],
        )
        cfg.validate()
        return cfg
