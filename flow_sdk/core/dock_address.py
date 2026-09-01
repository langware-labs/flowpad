"""Dock addressing — Python side of a cross-language contract.

A **dock address** is what the URL bar carries:
``/<layout>[/<page>]/<viewType>[/<pointer...>][?<options>]``. It was owned
solely by the frontend (``ui/src/navigation/DockPointer.ts`` +
``ui/src/navigation/url-builder.ts``) until the backend needed to reach more
than one view: ``dock_url`` in ``flow_sdk/core/display_target.py`` hand-built
exactly one shape (the asset editor), and the agent's ``ui_command`` vocabulary
could address an entity or a file but never a *screen*.

This module mirrors the half the backend consumes: the view vocabulary, the
retirement map, the per-view facts needed to VALIDATE an address, and the
URL build/parse pair. Viewer chrome (``title`` / ``iconName`` / ``tabLocation``
/ ``canAddAsTab``) stays TypeScript-only — a duplicated row nobody reads is
drift waiting to happen (the same rule ``asset_editor.py`` follows for
``editorForPath``).

**Tab identity is deliberately NOT mirrored.** ``DockPointer.tabHash`` is the
single canonicalizer — which pointers collapse to one tab — and both sides say
so out loud (``flow_sdk/builtin/tab.py`` module docstring; the ``tabHash``
getter in ``DockPointer.ts``). ``Tab.id`` is ``uuid5`` over that string, so a
one-byte disagreement would silently re-key every persisted tab row. What this
module exposes is :func:`can_be_tab` — the *derived null-ness* of that hash,
which is a property of the view, not of the grammar. Do not add a ``tab_hash``
here, however convenient it looks.

The two sides are pinned by ``tests/fixtures/dock_address_contract.json``,
which BOTH ``tests/unit/test_dock_address_contract.py`` and
``ui/tests/unit/dock-address-contract.test.ts`` assert against — neither
generates it. That is deliberate: a generated fixture would make one language
authoritative and reduce the other suite to a tautology, whereas an
independently-stated third copy means a Python-only edit here fails the
TypeScript suite too. Change the fixture only with both suites in hand.

Lives beside ``asset_editor.py`` and ``display_target.py``, which it serves.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping, Optional
from urllib.parse import quote, unquote, urlencode

from flow_sdk._compat import StrEnum

# ──────────────────────────────────────────────────────────────────────────
# Layout / page — the two segments in front of the viewType
# ──────────────────────────────────────────────────────────────────────────


class Layout(StrEnum):
    """URL layout keyword. Mirrors ``Layout`` in ``ts_sdk/.../view-types.ts``."""

    DOCK = "dock"
    DEV = "dev"
    WIN = "win"  # chrome-less focus window; same loaders, same view component


#: Recognized layout keywords, in the order the frontend scans for them.
#: ``dev`` and ``dock`` are historically interchangeable and the FIRST match in
#: a path wins, so order is part of the contract.
LAYOUT_KEYWORDS: tuple[str, ...] = (Layout.DOCK.value, Layout.DEV.value, Layout.WIN.value)


class PageId(StrEnum):
    """Which SPA surface a dock URL addresses.

    Sits between the layout keyword and the viewType. ``desk`` is the default
    and is **never emitted** (bare ``/dock/<viewType>`` == page ``desk``), so
    every pre-existing URL stays byte-identical.

    INVARIANT: no :class:`ViewType` value may ever equal a ``PageId`` value —
    parsing detects the page positionally, so a collision would silently
    reinterpret a viewType segment as a page. Pinned by the contract suite.
    """

    DESK = "desk"
    HUB = "hub"


# ──────────────────────────────────────────────────────────────────────────
# The view vocabulary
# ──────────────────────────────────────────────────────────────────────────


class ViewType(StrEnum):
    """Content-panel view ids. Values are the URL segment verbatim.

    Member ORDER mirrors ``ts_sdk/src/utils/ui/view-types.ts`` and is asserted
    by both contract suites — inserting a member mid-list is a fixture edit.
    """

    HOME = "home"  # Home/Landing page
    SYSTEM_PROFILE = "system_profile"  # Claude Code status (LiveStatus)
    ANALYSIS = "analysis"  # Session analysis overview
    CHAT = "chat"
    SHELL = "shell"
    EDITOR = "editor"
    WEB_APP = "web-app"
    # Retired decode-only aliases; the loader redirects to
    # /dock/credentials/<subview> and `normalize_retired` resolves saved tabs.
    ENVIRONMENT = "environment"
    CONNECTIONS = "connections"
    ARTIFACTS = "artifacts"
    REASONING = "reasoning"
    DIFF = "diff"
    UNSUPPORTED = "unsupported"  # fallback viewer
    MARKDOWN = "markdown"
    DOCS = "docs"
    ASSISTANCE = "assistance"  # expert assistance tasks
    SURVEY = "survey"
    API_KEYS = "api-keys"  # Retired decode-only alias; see ENVIRONMENT
    HOOKS = "hooks"  # Claude Code hooks configuration
    MACHINE = "machine"  # Machine overview (processes, network)
    EXPLORER = "explorer"  # File explorer view
    SKILLS = "skills"  # Retired: folded into assets `list/skill`
    AI_CONFIG = "ai-config"  # AI configuration (LLM APIs, CLIs)
    SHOW = "show"  # MCP UI display dock pointer
    APPS = "apps"  # Skill UI apps - /dock/apps/<uname>/<router>
    GRAPH = "graph"  # Dep-graph viewer - /dock/graph/<type>/<id>
    WORLDVIEW = "worldview"  # /dock[/hub]/worldview/<world|organization|deployment>
    # People-and-teams admin. The org WORLDVIEW is the same data drawn as a graph
    # and stays the advanced view; this is the plain screen.
    ORGANIZATION = "organization"  # /dock/hub/organization
    TAG = "tag"  # Tag taxonomy - /dock/tag/graph[/<dot.name>]?view=tree
    SUBGRAPH = "subgraph"  # /dock/subgraph/<projection>[/<focusKey>]
    K_BROWSER = "k-browser"  # Docs knowledge browser - /dock/k-browser/<vfs|typeid>/<value>
    LENS = "lens"  # Lens viewer for specialized content (e.g. transcripts)
    SESSION = "session"  # Retired: legacy /dock/session → /dock/shell/<process>
    TASKS = "tasks"  # Task create/edit view (delegates to assets)
    SETTINGS = "settings"  # Claude Code settings viewer
    PREFERENCES = "preferences"  # User preferences screen (category tabs)
    AGENTIC_PROCESS = "agentic_process"  # Process terminal view
    SEARCH = "search"  # Record semantic search view
    # The merged rules+events screen. TRIGGERS / SIGNALS / CRON are kept as
    # ALIASES onto it (same body, same navigator) rather than redirects, so
    # every bookmarked URL keeps working.
    EVENTS = "events"  # Rules and the events they fire on
    TRIGGERS = "triggers"  # Alias of EVENTS
    CAPABILITIES = "capabilities"  # System capability checks/install/test
    GRAPH_WORKFLOWS = "graph-workflows"  # Flow-graph editor/observatory — dev mode
    SIGNALS = "signals"  # Alias of EVENTS
    DATA_SOURCES = "data-sources"  # Configured ingestion sources
    PROCESS_RUNS = "process-runs"  # AgenticProcess execution history
    PLAN = "plan"  # Plan viewer with Milkdown editor
    CRON = "cron"  # Alias of EVENTS (scheduled jobs)
    ASSETS = "assets"  # Unified docs/skills/workflows tree
    PROJECT = "project"  # Collaboration on a project
    INBOX = "inbox"  # Received FlowMessages from hub
    CONVERSATION = "conversation"  # Single Conversation viewer
    SPEC = "spec"  # Single Spec viewer
    GRAPH_CONTEXT = "graph_context"  # Frozen-context viewer
    DIAGNOSIS = "diagnosis"  # Single FlowpadDiagnosis viewer
    DESKTOP = "desktop"  # Full-page favorites desktop (BrowseableGrid)
    LIVE_SESSION = "live_session"  # Live remote-worker session
    HELPDESK = "helpdesk"  # Helpdesk portal - /dock/helpdesk/<projectId>[/article/<path>]
    ATLAS = "atlas"  # Retired: redirects to /dock/hub/worldview/…
    HUB_RECORDS = "records"  # Hub entity list by type (page=hub)
    HUB_ENTITY = "entity"  # Hub single-entity viewer (page=hub)
    CREDENTIALS = "credentials"  # Env vars + OAuth connections + API keys
    # An Artifact-backed web app - /dock/app/artifact-<uuid>[?runtime=dev|served].
    # The ADDRESS is the artifact (the source plane); the runtime it is served from
    # is DERIVED at resolve time from its Deployment/MicroApp companions, so a dev
    # server that dies or a build that lands never changes the app's identity.
    # Named `app`, not `artifact`: `artifact` is a real EntityType, and a ViewType
    # whose string shadows one mints entity targets from a bare-id pointer
    # (`DockPointer.targetTypeId`) — the pinned shadow set in the contract suite
    # exists to keep that deliberate.
    APP = "app"
    LLM_ENDPOINTS = "llm-endpoints"  # Hub LLM endpoints (roots + chains) - /dock/hub/llm-endpoints[/<id>[/<tab>]]
    TOKEN_PLAN = "token-plan"  # Hub token plan (me / team / org budgets) - /dock/hub/token-plan[/<scope>]


# ── pointer vocabularies for the views whose pointer is a closed set ───────


class CredentialsSubview(StrEnum):
    """``/dock/credentials/<subview>[/<projectId>]``."""

    ENVIRONMENT = "environment"
    CONNECTIONS = "connections"
    API_KEYS = "api-keys"


class WebappSubview(StrEnum):
    """``/dock/web-app/<subview>``."""

    SHELL = "webapp-shell"
    ARTIFACTS = "webapp-artifacts"


class MachineSubview(StrEnum):
    """``/dock/machine/<subview>``."""

    PROCESSES = "processes"
    NETWORK = "network"
    METRICS = "metrics"  # E2B only — CPU/Memory charts
    LOGS = "logs"  # E2B only — sandbox logs
    SECRETS = "secrets"  # NOT E2B-gated; the local desktop node needs it too


class AIConfigSubview(StrEnum):
    """``/dock/ai-config/<subview>``."""

    LLM_APIS = "llm-apis"
    CLIS = "clis"


class TokenPlanKind(StrEnum):
    """``/dock/hub/token-plan/<scope>[/<teamId>]``.

    A closed leading segment like ``CredentialsSubview``, so it is pinned in the
    contract rather than respelled per language: the frontend parser and the
    hub service each had their own copy of this list before.
    """

    ME = "me"
    TEAM = "team"
    ORG = "org"


# ──────────────────────────────────────────────────────────────────────────
# Retirement — a view can be deleted from the UI but not from history
# ──────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RetiredTarget:
    """Where a retired view forwards to."""

    view_type: ViewType
    pointer: str


#: Mirrors ``RETIRED_DOCK_VIEWS`` in ``ts_sdk/src/utils/ui/retired-views.ts``.
#: A retired view stays DECODABLE — it is baked into saved ``Tab`` rows,
#: bookmarks and links people already sent each other — and resolves forward
#: here. The retired trio never carried a pointer of their own, so the subview
#: REPLACES the pointer outright rather than merging with it.
RETIRED_DOCK_VIEWS: Mapping[ViewType, RetiredTarget] = {
    ViewType.ENVIRONMENT: RetiredTarget(ViewType.CREDENTIALS, CredentialsSubview.ENVIRONMENT.value),
    ViewType.CONNECTIONS: RetiredTarget(ViewType.CREDENTIALS, CredentialsSubview.CONNECTIONS.value),
    ViewType.API_KEYS: RetiredTarget(ViewType.CREDENTIALS, CredentialsSubview.API_KEYS.value),
}


def normalize_retired(view_type: ViewType, pointer: Optional[str] = None) -> tuple[ViewType, Optional[str]]:
    """Resolve a retired view forward.

    Returns the pair unchanged when it names a live view, so callers can apply
    it unconditionally (the TS ``normalizeRetiredDockPointer`` contract).
    """
    target = RETIRED_DOCK_VIEWS.get(view_type)
    if target is None:
        return view_type, pointer
    return target.view_type, target.pointer


# ──────────────────────────────────────────────────────────────────────────
# Per-view facts the backend needs to validate an address
# ──────────────────────────────────────────────────────────────────────────


class PointerRequirement(StrEnum):
    """Whether a view's pointer segment is required to address it."""

    NONE = "none"  # addressing rides entirely in query options
    OPTIONAL = "optional"
    REQUIRED = "required"


@dataclass(frozen=True)
class ViewMeta:
    """What the BACKEND consumes about a view. Viewer chrome stays in TS.

    ``addressable`` is False for a view with no ``VIEWER_REGISTRY`` row — the
    retired aliases and the folded-away ``skills`` / ``session``. Those still
    DECODE (history is forever) but must never be offered as a destination.
    """

    addressable: bool
    pointer: PointerRequirement
    folds_pointer: bool = False
    scope_keyed: bool = False
    chrome: str = "workspace"  # "workspace" | "fullbleed"


def _m(
    pointer: PointerRequirement,
    *,
    addressable: bool = True,
    folds_pointer: bool = False,
    scope_keyed: bool = False,
    chrome: str = "workspace",
) -> ViewMeta:
    return ViewMeta(
        addressable=addressable,
        pointer=pointer,
        folds_pointer=folds_pointer,
        scope_keyed=scope_keyed,
        chrome=chrome,
    )


_REQ = PointerRequirement.REQUIRED
_OPT = PointerRequirement.OPTIONAL
_NONE = PointerRequirement.NONE

#: One row per :class:`ViewType`. The contract suite asserts completeness, so a
#: view added in TypeScript cannot land here unclassified.
VIEW_META: Mapping[ViewType, ViewMeta] = {
    ViewType.HOME: _m(_OPT, chrome="fullbleed"),
    ViewType.SYSTEM_PROFILE: _m(_OPT),
    ViewType.ANALYSIS: _m(_OPT),
    ViewType.CHAT: _m(_OPT),
    ViewType.SHELL: _m(_OPT),
    ViewType.EDITOR: _m(_OPT),
    ViewType.WEB_APP: _m(_OPT),
    ViewType.ENVIRONMENT: _m(_NONE, addressable=False),
    ViewType.CONNECTIONS: _m(_NONE, addressable=False),
    ViewType.ARTIFACTS: _m(_OPT),
    ViewType.REASONING: _m(_OPT),
    ViewType.DIFF: _m(_REQ),
    ViewType.UNSUPPORTED: _m(_OPT),
    ViewType.MARKDOWN: _m(_OPT),
    ViewType.DOCS: _m(_OPT),
    ViewType.ASSISTANCE: _m(_OPT),
    ViewType.SURVEY: _m(_OPT),
    ViewType.API_KEYS: _m(_NONE, addressable=False),
    ViewType.HOOKS: _m(_OPT),
    ViewType.MACHINE: _m(_OPT),
    ViewType.EXPLORER: _m(_OPT, scope_keyed=True),
    ViewType.SKILLS: _m(_OPT, addressable=False),
    ViewType.AI_CONFIG: _m(_OPT),
    ViewType.SHOW: _m(_REQ),
    ViewType.APPS: _m(_REQ),
    ViewType.GRAPH: _m(_REQ),
    ViewType.WORLDVIEW: _m(_REQ),
    # OPTIONAL, not REQUIRED like the graph beside it: the screen opens on the
    # organization you belong to, and only carries a pointer when you deep-link to
    # a particular team.
    ViewType.ORGANIZATION: _m(_OPT),
    ViewType.TAG: _m(_REQ, folds_pointer=True),
    ViewType.SUBGRAPH: _m(_REQ, folds_pointer=True),
    ViewType.K_BROWSER: _m(_REQ),
    ViewType.LENS: _m(_REQ),
    ViewType.SESSION: _m(_REQ, addressable=False),
    ViewType.TASKS: _m(_OPT),
    ViewType.SETTINGS: _m(_OPT),
    ViewType.PREFERENCES: _m(_OPT, folds_pointer=True),
    ViewType.AGENTIC_PROCESS: _m(_REQ),
    ViewType.SEARCH: _m(_NONE),
    ViewType.EVENTS: _m(_NONE),
    ViewType.TRIGGERS: _m(_NONE),
    ViewType.CAPABILITIES: _m(_NONE),
    ViewType.GRAPH_WORKFLOWS: _m(_OPT),
    ViewType.SIGNALS: _m(_NONE),
    ViewType.DATA_SOURCES: _m(_NONE),
    ViewType.PROCESS_RUNS: _m(_OPT),
    ViewType.PLAN: _m(_REQ),
    ViewType.CRON: _m(_NONE),
    ViewType.ASSETS: _m(_REQ, scope_keyed=True),
    ViewType.PROJECT: _m(_REQ),
    ViewType.INBOX: _m(_NONE),
    ViewType.CONVERSATION: _m(_REQ),
    ViewType.SPEC: _m(_REQ),
    ViewType.GRAPH_CONTEXT: _m(_REQ),
    ViewType.DIAGNOSIS: _m(_REQ),
    ViewType.DESKTOP: _m(_NONE, scope_keyed=True),
    ViewType.LIVE_SESSION: _m(_REQ),
    ViewType.HELPDESK: _m(_REQ, folds_pointer=True),
    ViewType.ATLAS: _m(_OPT, addressable=False),
    ViewType.HUB_RECORDS: _m(_REQ),
    ViewType.HUB_ENTITY: _m(_REQ),
    ViewType.CREDENTIALS: _m(_OPT, folds_pointer=True),
    # Pointer REQUIRED: an app with no artifact is not an address. Runtime rides in
    # options, so it is excluded from tab identity and switching dev/served
    # re-points the SAME tab instead of forking one per runtime.
    ViewType.APP: _m(_REQ),
    ViewType.LLM_ENDPOINTS: _m(_OPT, folds_pointer=True),
    ViewType.TOKEN_PLAN: _m(_OPT, folds_pointer=True),
}


def parse_view_type(token: Optional[str]) -> Optional[ViewType]:
    """Coerce a URL segment to a :class:`ViewType`, or ``None``.

    Non-throwing by design — the Python twin of ``isValidView``. Callers that
    want an error decide what kind of error it is.
    """
    if not token:
        return None
    try:
        return ViewType(token)
    except ValueError:
        return None


def can_be_tab(view_type: ViewType, pointer: Optional[str] = None) -> bool:
    """Would this address get a tab chip? (i.e. is ``tabHash`` non-null?)

    The DERIVED null-ness of ``DockPointer.tabHash``, never the hash itself —
    see the module docstring. Two views have no chip:

    * a full-bleed surface (Home) takes over the panel, so there is no strip;
    * a BARE shell is the terminal host, not a tab — only a session-pointer
      shell is one.
    """
    meta = VIEW_META.get(view_type)
    if meta is not None and meta.chrome == "fullbleed":
        return False
    if view_type is ViewType.SHELL and not pointer:
        return False
    return True


# ──────────────────────────────────────────────────────────────────────────
# Build / parse
# ──────────────────────────────────────────────────────────────────────────

#: ``encodeURIComponent`` leaves these unescaped; Python's ``quote`` default
#: does not. Matching it exactly is what keeps a wiki name like
#: ``Design Notes (draft)`` byte-identical across the two builders.
_SEGMENT_SAFE = "-_.!~*'()"


def dock_url(
    view_type: ViewType,
    pointer: Optional[str] = None,
    options: Optional[Mapping[str, Optional[str]]] = None,
    *,
    layout: Layout = Layout.DOCK,
    page: PageId = PageId.DESK,
    base: str = "",
) -> str:
    """Build a dock URL path. The Python twin of ``buildDockUrl``.

    ``base`` is everything before the layout keyword (the legacy
    ``/agent/<id>/flow/<id>`` prefix); empty for every current caller.

    Note this returns a PATH, not an absolute URL. Callers that need a host
    add one — the wire deliberately carries the address, never a baked URL
    (see ``display_target.dock_url``).
    """
    page_segment = "" if page is PageId.DESK else f"/{page.value}"
    url = f"{base}/{layout.value}{page_segment}/{view_type.value}"

    if pointer:
        clean = pointer[1:] if pointer.startswith("/") else pointer
        url += "/" + "/".join(quote(seg, safe=_SEGMENT_SAFE) for seg in clean.split("/"))

    if not options:
        return url
    # `undefined`/None values are dropped, mirroring the URLSearchParams build.
    pairs = [(k, v) for k, v in options.items() if v is not None]
    query = urlencode(pairs)
    return f"{url}?{query}" if query else url


@dataclass(frozen=True)
class DockAddress:
    """A parsed dock URL."""

    view_type: ViewType
    pointer: Optional[str] = None
    options: Mapping[str, str] = field(default_factory=dict)
    layout: Layout = Layout.DOCK
    page: PageId = PageId.DESK
    base: str = ""


def _split_query(path: str) -> tuple[str, dict[str, str]]:
    if "?" not in path:
        return path, {}
    head, _, raw = path.partition("?")
    options: dict[str, str] = {}
    for chunk in raw.split("&"):
        if not chunk:
            continue
        key, _, value = chunk.partition("=")
        # `+` is a space in a query string; unquote alone does not handle it.
        options[unquote(key.replace("+", " "))] = unquote(value.replace("+", " "))
    return head, options


def parse_dock_url(path: str) -> Optional[DockAddress]:
    """Parse a dock URL path into a :class:`DockAddress`, or ``None``.

    Mirrors ``parseDockUrl`` + ``DockPointer.fromUrl``'s decode step. Returns
    ``None`` when the path carries no layout keyword or names no known view —
    the caller decides whether that is an error.
    """
    if not path:
        return None
    head, options = _split_query(path)
    segments = [s for s in head.split("/") if s]

    # The layout keyword is the FIRST recognized one; everything before it is
    # the legacy base path.
    layout_index = next((i for i, s in enumerate(segments) if s in LAYOUT_KEYWORDS), None)
    if layout_index is None:
        return None

    base = "/" + "/".join(segments[:layout_index]) if layout_index else ""
    rest = segments[layout_index + 1 :]
    if not rest:
        return None

    # The page is positional: present only when the segment right after the
    # layout keyword is a known page id. `desk` is never emitted, so a bare
    # `/dock/<viewType>` parses as desk.
    page = PageId.DESK
    try:
        page = PageId(rest[0])
        rest = rest[1:]
    except ValueError:
        pass
    if not rest:
        return None

    view_type = parse_view_type(rest[0])
    if view_type is None:
        return None

    pointer = "/".join(unquote(seg) for seg in rest[1:]) or None
    return DockAddress(
        view_type=view_type,
        pointer=pointer,
        options=options,
        layout=Layout(segments[layout_index]),
        page=page,
        base=base,
    )
