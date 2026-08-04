"""Typed failures for instance management.

Every error carries an ``exit_code`` because this package's only consumer is a
CLI whose callers branch on exit status — four TS harnesses and two shell
scripts exec it and never parse its prose. A caller that must distinguish "you
asked for a name that was never allocated" from "the ports band is full" gets
that from the status code, not from a regex over stderr.
"""

from __future__ import annotations


class InstanceError(Exception):
    """Base for every instance-management failure. ``exit_code`` is the CLI status."""

    exit_code = 1


class NameInvalid(InstanceError):
    """The instance name is not a legal instance name (see ``paths.validate_name``).

    Raised *before* any path is derived from the name — this is the
    path-traversal guard, not a cosmetic check.
    """

    exit_code = 2


class UnknownInstance(InstanceError):
    """The name is legal but nothing on disk or in the process table knows it."""

    exit_code = 3


class NoSuchRole(InstanceError):
    """The instance exists but its kind has no such role (e.g. backend on hub-ui)."""

    exit_code = 3


class PortExhausted(InstanceError):
    """No free port remained in the requested band."""

    exit_code = 4


class ProtectedInstance(InstanceError):
    """The operation targets a protected instance and was not explicitly authorized."""

    exit_code = 5


class KillFailed(InstanceError):
    """One or more owned processes survived SIGKILL."""

    exit_code = 1
