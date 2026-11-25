"""``browser_driver.json`` — one way a session drives a browser.

The asset folder is ``agentic-assets/browser_driver/<name>/``: this manifest and
``instructions.md`` (what a session using it is told). The loader and the verbs are
``flow_sdk/core/browser_drivers.py``; which one a session gets is ``browser_choice``.

Everything a new browser needs is declared here, so adding one is adding a folder: which
workers it supports and how it reaches each (``workers``), the MCP server it brings (``mcp``),
what a person can configure (``config_fields`` / ``defaults``), and how its state is read
(``managed`` / ``probe``).
"""
from __future__ import annotations

from enum import StrEnum
from typing import ClassVar, Optional

from pydantic import Field, computed_field

from flow_sdk.schema.data_spec.frontmatter import AssetDocumentSpec
from flow_sdk.schema.data_spec.secret_manager_spec import ConfigFieldSpec
from flow_sdk.schema.data_spec.spec import DataSpec

#: The key in ``workers`` that stands for every worker not named there.
ANY_WORKER = "*"


class BrowserAttach(StrEnum):
    """How a driver reaches a session."""

    #: The driver's own MCP server (``mcp``), added to the session — works on any worker.
    MCP_SERVER = "mcp_server"
    #: The worker's own browser switch (``AgentOptions.EXTENSION_FLAG``) — only where it has one.
    HARNESS_EXTENSION = "harness_extension"


class BrowserProbe(StrEnum):
    """How a driver's availability is read. Never starts anything."""

    #: The window's debugging port answers.
    CDP = "cdp"
    #: The worker's own record of its extension.
    EXTENSION = "extension"


#: What parts a kind's fixed head from the profile, which is kept whole (a profile's folder id
#: may hold a space or a dot).
KIND_NAME = ".name."


def parse_kind(kind: object) -> tuple[str, str, str]:
    """``<browser>.<driving>.name.<profile>`` → ``(browser, driving, profile)``; three empty
    strings when ``kind`` is not one."""
    head, sep, profile = str(kind or "").partition(KIND_NAME)
    browser, dot, driving = head.rpartition(".")
    return (browser, driving, profile) if sep and dot and browser and profile else ("", "", "")


class BrowserKindSpec(DataSpec):
    """One browser a session can be given: a browser app, the way it is driven, and one profile.
    ``kind`` names it — ``<browser>.<driving>.name.<profile>`` (``chrome.extension.name.Profile 2``)."""

    #: The browser app, by ``browser_profiles`` id (``chrome``, ``canary``).
    browser: str
    #: How it is driven — the driver's ``probe``: ``extension`` or ``cdp``.
    driving: BrowserProbe
    #: The profile's folder id, never its displayed name: a displayed name can repeat and change.
    profile: str
    #: What a person reads; starts as the profile's displayed name.
    name: str
    #: The driver folder that drives it, and what a menu draws from it.
    driver: str
    icon: str = ""
    install_url: str = ""
    #: One word for a menu (``browser_drivers.state_of``), or ``error`` with what a session reported.
    state: str = ""
    error: str = ""
    #: The person took it off this machine's list; the browser itself is untouched.
    removed: bool = False
    created: Optional[str] = None
    last_used: Optional[str] = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def kind(self) -> str:
        return f"{self.browser}.{self.driving.value}{KIND_NAME}{self.profile}"


class WorkerSetupSpec(DataSpec):
    """One supported worker: how the driver reaches it and what a person does first."""

    attach: BrowserAttach = BrowserAttach.MCP_SERVER
    #: What to set up for this worker, in plain words; shown in the menu and the editor.
    setup: str = ""


class BrowserMcpSpec(DataSpec):
    """The MCP server a session gets. ``command`` and ``args`` are templates over the driver's
    config plus ``{python}`` (this interpreter) and ``{driver}`` (its name); a value fills ONE
    argument and is never shell syntax."""

    name: str = Field(min_length=1)
    command: str = Field(min_length=1)
    args: list[str] = Field(default_factory=list)


class BrowserDriverSpec(AssetDocumentSpec):
    main_file: ClassVar[str | None] = "browser_driver.json"

    #: The registry key AND the folder name; what a project's ``browser`` and a person's pick hold.
    name: str = Field(min_length=1)
    title: str = ""
    icon: str = ""
    description: str = ""
    #: The workers it supports, by vendor key (``claude``, ``codex``…); ``*`` is every other
    #: worker. A worker with no entry is unsupported and gets the default driver instead.
    workers: dict[str, WorkerSetupSpec] = Field(default_factory=dict)
    mcp: Optional[BrowserMcpSpec] = None
    #: Flowpad starts and owns the window (a profile of its own); else the worker owns it.
    managed: bool = False
    #: The browser apps a managed driver may run, by ``browser_profiles`` id; the first installed
    #: one is the default.
    apps: list[str] = Field(default_factory=list)
    probe: BrowserProbe = BrowserProbe.CDP
    #: What a person can configure (the editor's form); values are kept per machine.
    config_fields: list[ConfigFieldSpec] = Field(default_factory=list)
    defaults: dict[str, str] = Field(default_factory=dict)
    #: The tool-name prefixes that mean "this session drove this browser" (``mcp__<server>__``).
    tool_prefixes: list[str] = Field(default_factory=list)
    #: Where a person installs what this driver needs; "" when there is nothing to install.
    install_url: str = ""
