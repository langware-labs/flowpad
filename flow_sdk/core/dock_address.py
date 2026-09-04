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
    RAG = "rag"  # Search indexes and the folders they cover
    PROCESS_RUNS = "process-runs"  # AgenticProcess execution history
    PLAN = "plan"  # Plan viewer with Milkdown editor
    CRON = "cron"  # Alias of EVENTS (scheduled jobs)
    ASSETS = "assets"  # Unified docs/skills/workflows tree
    PROJECT = "project"  # Collaboration on a project
    AGENT = "agent"  # Agent-owned surfaces — /dock/agent/<agent-id>/inbox
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
    # DESK page: what funds this machine's harnesses. Every fact it renders is a box fact
    # (a device token, a stored key, the endpoint BINDING), so it has no hub half.
    LLM_SOURCES = "llm-sources"  # /dock/llm-sources[/<worker>] -- the harness in focus


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
    """Where a retired view forwards to.

    Every row remains decodable for saved history. ``accepts_direct_address``
    separately says whether a new navigation command may use the retired name.
    """

    view_type: ViewType
    pointer: str
    accepts_direct_address: bool = True


#: Mirrors ``RETIRED_DOCK_VIEWS`` in ``ts_sdk/src/utils/ui/retired-views.ts``.
#: A retired view stays DECODABLE — it is baked into saved ``Tab`` rows,
#: bookmarks and links people already sent each other — and resolves forward
#: here. The retired trio never carried a pointer of their own, so the subview
#: REPLACES the pointer outright rather than merging with it.
#: All three land on CONNECTIONS: it is the only subview that still renders.
#: Forwarding a saved tab onto `environment` / `api-keys` would resolve it to a
#: pointer that is itself retired, leaving anything that reads `dock.pointer`
#: without a second hop on a blank pane. One hop, one table.
RETIRED_DOCK_VIEWS: Mapping[ViewType, RetiredTarget] = {
    ViewType.ENVIRONMENT: RetiredTarget(ViewType.CREDENTIALS, CredentialsSubview.CONNECTIONS.value),
    ViewType.CONNECTIONS: RetiredTarget(ViewType.CREDENTIALS, CredentialsSubview.CONNECTIONS.value),
    ViewType.API_KEYS: RetiredTarget(ViewType.CREDENTIALS, CredentialsSubview.CONNECTIONS.value),
    # Skills folded into the Assets browser (`/dock/assets/list/skill`).
    ViewType.SKILLS: RetiredTarget(
        ViewType.ASSETS,
        "list/skill",
        accepts_direct_address=False,
    ),
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

    ``label`` / ``aliases`` are the AGENT's half of the vocabulary, and the one
    thing this table deliberately does NOT take from TypeScript. ``VIEWER_REGISTRY``
    already carries a ``title`` per view, but it is a lingui descriptor — localized,
    and a translated screen name reaching an agent is worse than a raw slug. So the
    label is stated here, in English. None of the three is in the contract fixture:
    there is no TypeScript statement of them to disagree with, so a fixture row would
    assert Python against a copy of Python — the tautology that file exists to avoid.

    ``pages`` is the one to watch. It restates which renderer has a case for the view
    (``renderHubBody`` vs the desk content panel), so unlike the other two it CAN
    drift — adding a view to the hub renderer and not here leaves a real address
    rejected. There is no TS row to pin it against today; if one is added to
    ``VIEWER_REGISTRY``, pin it in the fixture like ``chrome``.

    ``aliases`` is the load-bearing half, not a nicety: a label alone does not make a
    screen findable, because the Connections screen's title is "Credentials" and that
    is not the word anyone uses for it. See ``docs/display-capabilities.md``.

    An alias MAY equal a non-addressable slug (``connections``, ``skills``) — those
    are retired names that already forward to the same place, so the alias agrees
    with ``normalize_retired`` rather than fighting it. It may never equal an
    ADDRESSABLE slug, or the vocabulary would have two answers for one word.
    """

    pointer: PointerRequirement
    addressable: bool = True
    folds_pointer: bool = False
    scope_keyed: bool = False
    chrome: str = "workspace"  # "workspace" | "fullbleed"
    label: str = ""  # English, agent-facing: "Search indexes", not "rag"
    aliases: tuple[str, ...] = ()  # what a user might call it, lowercase
    pages: tuple[str, ...] = ("desk",)  # which PageId(s) render it


#: The table below builds rows directly. ``pointer`` leads and ``addressable``
#: defaults to True, so a row is `_m(_OPT, label="…")` — a pass-through wrapper
#: would only mean declaring every new field three times.
_m = ViewMeta


_REQ = PointerRequirement.REQUIRED
_OPT = PointerRequirement.OPTIONAL
_NONE = PointerRequirement.NONE

#: One row per :class:`ViewType`. The contract suite asserts completeness, so a
#: view added in TypeScript cannot land here unclassified.
VIEW_META: Mapping[ViewType, ViewMeta] = {
    ViewType.HOME: _m(_OPT, chrome="fullbleed", label="Home", aliases=("landing", "start")),
    ViewType.SYSTEM_PROFILE: _m(
        _OPT, label="System Profile", aliases=("claude code status", "live status")
    ),
    ViewType.ANALYSIS: _m(_OPT, addressable=False),
    ViewType.CHAT: _m(_OPT, addressable=False),
    ViewType.SHELL: _m(_OPT, label="Worker", aliases=("chats", "terminal")),
    ViewType.EDITOR: _m(_OPT, label="Code Editor", aliases=("edit file",)),
    ViewType.WEB_APP: _m(_OPT, label="Web App", aliases=("web apps",)),
    # ANALYSIS / CHAT / REASONING / UNSUPPORTED below are NOT addressable either.
    # They have no case in the content panel and no VIEWER_REGISTRY row, so a dock
    # URL naming one falls to `default: <HomeLanding/>` — `flow show view chat`
    # returned exit 0 and showed the user Home. A destination that silently answers
    # with a different screen is worse than one that errors.
    ViewType.ENVIRONMENT: _m(_NONE, addressable=False),
    ViewType.CONNECTIONS: _m(_NONE, addressable=False),
    ViewType.ARTIFACTS: _m(_OPT, label="Artifacts", aliases=("deliverables",)),
    ViewType.REASONING: _m(_OPT, addressable=False),
    ViewType.DIFF: _m(_REQ, label="Diff Viewer", aliases=("changes",)),
    ViewType.UNSUPPORTED: _m(_OPT, addressable=False),
    ViewType.MARKDOWN: _m(_OPT, label="Markdown", aliases=("document",)),
    ViewType.DOCS: _m(_OPT, label="Docs", aliases=("documentation",)),
    ViewType.ASSISTANCE: _m(_OPT, label="Assistance", aliases=("expert assistance",)),
    ViewType.SURVEY: _m(_OPT, label="Survey"),
    ViewType.API_KEYS: _m(_NONE, addressable=False),
    ViewType.HOOKS: _m(_OPT, label="Hooks", aliases=("claude hooks",)),
    ViewType.MACHINE: _m(_OPT, label="Machine", aliases=("system", "this machine")),
    ViewType.EXPLORER: _m(
        _OPT, scope_keyed=True, label="Files", aliases=("file tree", "folders")
    ),
    ViewType.SKILLS: _m(_OPT, addressable=False),
    ViewType.AI_CONFIG: _m(
        _OPT, label="AI Configuration", aliases=("ai config", "llm apis", "models", "clis")
    ),
    ViewType.SHOW: _m(_REQ, label="Show"),
    ViewType.APPS: _m(_REQ, label="Skill apps"),
    ViewType.GRAPH: _m(_REQ, label="Graph", aliases=("dep graph", "dependency graph")),
    ViewType.WORLDVIEW: _m(
        _REQ, label="WorldView", aliases=("world", "org graph"), pages=("desk", "hub")
    ),
    # OPTIONAL, not REQUIRED like the graph beside it: the screen opens on the
    # organization you belong to, and only carries a pointer when you deep-link to
    # a particular team.
    ViewType.ORGANIZATION: _m(
        _OPT, label="Organization", aliases=("people", "teams", "members"), pages=("hub",)
    ),
    ViewType.TAG: _m(
        _REQ, folds_pointer=True, label="Tag Graph", aliases=("tags", "taxonomy")
    ),
    ViewType.SUBGRAPH: _m(_REQ, folds_pointer=True, label="Subgraph"),
    ViewType.K_BROWSER: _m(
        _REQ, label="Knowledge Browser", aliases=("docs browser",)
    ),
    ViewType.LENS: _m(_REQ, label="Lens", aliases=("transcript",)),
    ViewType.SESSION: _m(_REQ, addressable=False),
    ViewType.TASKS: _m(_OPT, label="Tasks", aliases=("todo",)),
    ViewType.SETTINGS: _m(_OPT, label="Settings", aliases=("claude settings",)),
    ViewType.PREFERENCES: _m(
        _OPT, folds_pointer=True, label="Preferences", aliases=("my preferences", "appearance")
    ),
    ViewType.AGENTIC_PROCESS: _m(_REQ, label="Process"),
    ViewType.SEARCH: _m(_NONE, label="Search", aliases=("find",)),
    ViewType.EVENTS: _m(_NONE, label="Events", aliases=("rules", "event bus")),
    ViewType.TRIGGERS: _m(_NONE, label="Events"),
    ViewType.CAPABILITIES: _m(_NONE, label="Capabilities", aliases=("checks", "system checks")),
    ViewType.GRAPH_WORKFLOWS: _m(_OPT, label="Graph Workflows", aliases=("workflows",)),
    ViewType.SIGNALS: _m(_NONE, label="Events"),
    ViewType.DATA_SOURCES: _m(
        _NONE, label="Data sources", aliases=("connectors", "integrations", "ingestion", "sources")
    ),
    ViewType.RAG: _m(
        _NONE,
        label="Search indexes",
        aliases=("embeddings", "knowledge index", "vector index"),
    ),
    ViewType.PROCESS_RUNS: _m(_OPT, label="Runs", aliases=("history",)),
    ViewType.PLAN: _m(_REQ, label="Plan"),
    ViewType.CRON: _m(_NONE, label="Events", aliases=("schedule", "scheduled jobs")),
    # OPTIONAL, not REQUIRED: `/dock/assets` already renders — `AssetsPage` takes no
    # pointer prop and tab identity is the SCOPE (scope_keyed), not the pointer. The
    # REQUIRED it carried meant the URL worked in a browser while `flow show view
    # assets` was rejected, so the tree was unreachable by name. Verified bare.
    ViewType.ASSETS: _m(
        _OPT,
        scope_keyed=True,
        label="Assets",
        aliases=("library", "docs tree"),
        pages=("desk", "hub"),
    ),
    # Same: a bare project dock is the assets workspace (see the PROJECT arm in
    # `content-panel.tsx`, which documents exactly that and was unaddressable).
    ViewType.PROJECT: _m(
        _OPT, label="Collaboration", aliases=("room",), pages=("desk", "hub")
    ),
    # `<agentId>/inbox` — the id leads, so the pointer is required.
    ViewType.AGENT: _m(_REQ, label="Agent"),
    ViewType.INBOX: _m(_NONE, label="Inbox", aliases=("messages",)),
    ViewType.CONVERSATION: _m(_REQ, label="Conversation", pages=("desk", "hub")),
    ViewType.SPEC: _m(_REQ, label="Spec"),
    ViewType.GRAPH_CONTEXT: _m(_REQ, label="Context", aliases=("frozen context",)),
    ViewType.DIAGNOSIS: _m(_REQ, label="Diagnosis"),
    ViewType.DESKTOP: _m(_NONE, scope_keyed=True, label="Desktop", aliases=("favorites",)),
    ViewType.LIVE_SESSION: _m(_REQ, label="Live Session"),
    ViewType.HELPDESK: _m(
        _REQ, folds_pointer=True, label="Help desk", aliases=("support",)
    ),
    ViewType.ATLAS: _m(_OPT, addressable=False),
    ViewType.HUB_RECORDS: _m(_REQ, label="Records", aliases=("hub records",), pages=("hub",)),
    ViewType.HUB_ENTITY: _m(_REQ, label="Entity", aliases=("hub entity",), pages=("hub",)),
    ViewType.CREDENTIALS: _m(
        _OPT,
        folds_pointer=True,
        label="Credentials",
        # `connections` / `environment` / `api-keys` are the retired slugs that
        # already forward here (RETIRED_DOCK_VIEWS), so naming them as aliases
        # agrees with `normalize_retired` instead of competing with it — and
        # `connections` is the word a user actually says for this screen.
        aliases=("connections", "secrets", "api keys", "keys", "env vars"),
        pages=("desk", "hub"),
    ),
    # Pointer REQUIRED: an app with no artifact is not an address. Runtime rides in
    # options, so it is excluded from tab identity and switching dev/served
    # re-points the SAME tab instead of forking one per runtime.
    ViewType.APP: _m(_REQ, label="App"),
    ViewType.LLM_ENDPOINTS: _m(
        _OPT, folds_pointer=True, label="LLM Endpoints", aliases=("endpoints",), pages=("hub",)
    ),
    ViewType.TOKEN_PLAN: _m(
        _OPT, folds_pointer=True, label="Token plan", aliases=("budget", "token budget"), pages=("hub",)
    ),
    ViewType.LLM_SOURCES: _m(
        _OPT, folds_pointer=True, label="LLM sources", aliases=("harness funding",)
    ),
}


def _normalize_name(token: str) -> str:
    """Fold a screen name to its match key: lowercase, separators as spaces."""
    return token.strip().lower().replace("-", " ").replace("_", " ")


def _build_view_names() -> Mapping[str, ViewType]:
    """Every word that names an addressable view → the view. Built once, at import.

    Labels, aliases and the slug itself all resolve here. The FIRST view to claim a
    word keeps it, and that is what collapses the `events` twins: `triggers`,
    `signals` and `cron` decode to the same screen and carry the same label, so
    without this the vocabulary would offer four addresses for one destination.
    """
    names: dict[str, ViewType] = {}
    for view, meta in VIEW_META.items():
        if not meta.addressable:
            continue
        for name in (_normalize_name(meta.label), *meta.aliases, _normalize_name(view.value)):
            names.setdefault(name, view)
    return names


_VIEW_NAMES: Mapping[str, ViewType] = _build_view_names()


def suggest_views(token: Optional[str], *, limit: int = 3) -> list[ViewType]:
    """Addressable views whose label, alias or slug matches ``token``, best first.

    For error messages, not for resolution: an address is still a slug, and
    guessing one for the caller would turn a typo into a confident wrong screen —
    which is the failure this whole vocabulary exists to stop. Naming candidates
    lets the agent retry on a real address instead of re-guessing from the word
    it already got wrong.
    """
    needle = _normalize_name(token or "")
    if not needle:
        return []
    # Exact before substring; `search indexes` must offer `rag` ahead of `search`.
    hits = sorted(
        (name for name in _VIEW_NAMES if needle in name),
        key=lambda name: (name != needle, len(name), name),
    )
    if not hits:
        # A misspelling ("conections"): substring matching cannot see through a
        # dropped letter, and the agent already believes it knows the name.
        from difflib import get_close_matches  # noqa: PLC0415

        hits = get_close_matches(needle, _VIEW_NAMES, n=limit, cutoff=0.75)
    # One screen per suggestion — several words can name the same view.
    return list(dict.fromkeys(_VIEW_NAMES[name] for name in hits))[:limit]


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


def dock_address(view_type: ViewType, page: PageId = PageId.DESK) -> str:
    """The bare address form ``flow show view`` takes — ``dock_url`` minus ``/dock/``.

    Exists so callers naming an address in prose (an error message telling an agent
    what to type) do not restate the page-elision rule: ``desk`` is the default and
    is NEVER emitted, so `desk/events` would be re-parsed with `desk` as the
    viewType. One statement of that rule, in :func:`dock_url`, and this reuses it.
    """
    return dock_url(view_type, page=page).removeprefix(f"/{Layout.DOCK.value}/")


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
