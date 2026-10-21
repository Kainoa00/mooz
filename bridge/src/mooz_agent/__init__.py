"""Bring your own AI agent into a mooz meeting."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("mooz-agent")
except PackageNotFoundError:  # a source tree that was never installed
    __version__ = "0.0.0"
