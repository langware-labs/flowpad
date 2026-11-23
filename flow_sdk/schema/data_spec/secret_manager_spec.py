"""``secret_manager.json`` — what a secret manager is and the commands that set it up.

The asset folder is ``agentic-assets/secret_manager/<name>/``; the loader and the run-time
verbs are ``flow_sdk/secrets/managers.py``.
"""
from __future__ import annotations

from typing import ClassVar

from pydantic import Field

from flow_sdk.schema.data_spec.frontmatter import AssetDocumentSpec
from flow_sdk.schema.data_spec.spec import DataSpec


class ConfigFieldSpec(DataSpec):
    """One field a vault of this manager is configured with."""

    name: str = Field(min_length=1)
    label: str = ""
    required: bool = False


class OsCommandsSpec(DataSpec):
    """One command per OS (``""``: none on that OS)."""

    darwin: str = ""
    linux: str = ""
    win32: str = ""


class SecretManagerSpec(AssetDocumentSpec):
    """``secret_manager.json`` — what a manager is and the commands that set it up."""

    main_file: ClassVar[str | None] = "secret_manager.json"

    name: str = Field(min_length=1)
    title: str = ""
    icon: str = ""
    description: str = ""
    config_fields: list[ConfigFieldSpec] = Field(default_factory=list)
    install: OsCommandsSpec = Field(default_factory=OsCommandsSpec)
    login: OsCommandsSpec = Field(default_factory=OsCommandsSpec)
    #: Exits 0 when this machine can read the vault.
    check: str = ""
    #: Gives ``{email}`` read access to the vault.
    grant: str = ""
    #: Exits 0 while access is open on this machine (signed in, unlocked). Must never prompt: it is run to
    #: show a state. Empty: the state is not known without asking for a value.
    status: str = ""
    #: Seals access on this machine (sign out, lock); ``login`` opens it again. Empty: it cannot be closed.
    close: str = ""
    #: Environment for every command, filled like a command (``{"OP_ACCOUNT": "{account}"}``); a
    #: variable whose placeholder the vault's config does not fill is left out.
    env: dict[str, str] = Field(default_factory=dict)
    #: What the person does when sign-in fails (a desktop-app setting, an approval): shown by the setup wizard.
    login_help: str = ""
