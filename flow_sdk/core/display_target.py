"""Display-target resolution — the one policy for "what does this address show".

Shared by the two agent-facing display verbs so they agree by construction:

* ``flow navigate`` (``server/routes/navigate.py``) — steers the browser tab.
* ``flow show`` (``AgenticProcess._http_show``) — sets the process's display
  focus via the ``on_show`` entity event.

Resolution policy (the ``flow navigate file`` behaviour):
  * typeid → the entity, or ``EntityNotFound`` (unknown type collapses too);
  * path   → the indexed asset's entity when one owns it via ``asset_ref``
             (stable editor view), else a raw vfs pointer — this is what makes
             "agent writes hello.md, then shows it" work without indexing;
  * artifact_id → an app, with its live runtime derived from its companions;
  * port   → a webapp preview (an entity-less dev server);
  * dock   → a SCREEN, addressed as ``<viewType>[/<pointer>][?<opts>]`` — the
             one address form that reaches a view with no entity behind it
             (Events, Preferences, Assets, …). Validated against the
             ``flow_sdk.core.dock_address`` table, which is pinned to the
             frontend's own vocabulary by a contract fixture.
"""

from __future__ import annotations

import asyncio
import os

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.path_utils import canonical_posix_path


class DisplayTargetKind(StrEnum):
    """Discriminator carried in resolved payloads (and asserted by the TS side)."""

    ENTITY = "entity"
    VFS = "vfs"
    WEBAPP = "webapp"
    APP = "app"
    SHELL = "shell"
    DOCK = "dock"


class InvalidDisplayTarget(ValueError):
    """The address itself is malformed (bad typeid / port / nothing given)."""


class DisplayTargetNotFound(LookupError):
    """A well-formed typeid that resolves to no entity."""


async def resolve_display_target(
    typeid: str | None = None,
    path: str | None = None,
    port: object = None,
    artifact_id: str | None = None,
    dock: str | None = None,
    discover: bool = False,
) -> dict:
    """Resolve one display address to its payload dict.

    Exactly one of ``typeid`` / ``path`` / ``artifact_id`` / ``port`` / ``dock``
    should be given (checked in that priority order). Returns ``{"kind":
    DisplayTargetKind, ...}``; raises ``InvalidDisplayTarget`` /
    ``DisplayTargetNotFound`` for the caller to map onto its own response shape
    (HTTP error body, exit code, ...).

    Resolution is READ-ONLY by default. ``discover=True`` additionally recovers
    a not-yet-indexed file by parsing it and ``sync_to_db``-ing the result — a
    mini index. That is right for a display verb ("show me the file I just
    wrote") and wrong for a query ("what is this file's URL"), so the mutation
    is opt-in and visible at the call site rather than inherited by omission.
    Without it, an unindexed path answers VFS and the caller can say
    "index it first".
    """
    if typeid:
        try:
            tid = TypeId(typeid)
        except (ValueError, IndexError) as e:
            raise InvalidDisplayTarget(f"Invalid typeid '{typeid}': {e}") from e
        try:
            entity = await Entity.get_by_typeid(tid)
        except ValueError:
            entity = None  # unknown type collapses to "not found"
        if entity is None:
            raise DisplayTargetNotFound(f"Entity not found: {typeid}")
        if entity.get_type() == "shell":
            # A terminal is not an editable document: it is HOSTED as a tab, so
            # the FE routes this kind to a shell-dock navigation rather than to
            # an editor. Without its own kind it would arrive as a generic
            # entity target, and `editorForType('shell')` is undefined — the
            # display would silently fall back to the empty preview.
            return shell_target(entity)
        return _entity_payload(entity)

    if path:
        resolved = canonical_posix_path(os.path.abspath(os.path.expanduser(path)))
        for lookup in _asset_lookup_paths(resolved):
            entity = await Entity.get_by_asset_ref(lookup)
            if entity is not None and getattr(entity, "id", None):
                return {**_entity_payload(entity), "path": resolved}
        rec_type, rec_path = _typed_asset_shape(resolved)
        if rec_type and discover:
            # Fresh asset (created seconds ago, not yet indexed): recover it
            # with the targeted single-file discovery — no tree walks — so the
            # bespoke editor renders instead of a raw file view.
            from flow_sdk.builtin.faas.fs_records_actions import discover_record_by_path  # noqa: PLC0415

            rec = await discover_record_by_path(rec_type, rec_path)
            if rec is not None and getattr(rec, "id", None):
                return {
                    "kind": DisplayTargetKind.ENTITY,
                    "typeid": f"{rec_type}-{rec.id}",
                    "type": rec_type,
                    "id": str(rec.id),
                    "name": getattr(rec, "name", None) or getattr(rec, "title", None) or None,
                    "path": resolved,
                }
        return {"kind": DisplayTargetKind.VFS, "path": resolved}

    if artifact_id:
        return await _app_payload(str(artifact_id))

    if port is not None:
        try:
            return {"kind": DisplayTargetKind.WEBAPP, "port": int(port)}  # type: ignore[arg-type]
        except (TypeError, ValueError) as e:
            raise InvalidDisplayTarget(f"Invalid port: {port!r}") from e

    if dock:
        return await dock_target(dock)

    raise InvalidDisplayTarget("Must include one of: typeid, path, port, artifact_id, dock")


async def _app_payload(artifact_id: str) -> dict:
    """Resolve an app by its Artifact — the source plane — plus its companions.

    An app is reachable two ways: a dev server on a port (``Deployment``) or its
    built output served by us (``MicroApp``). Both, either, or neither may exist
    at any moment, and which one is live changes without the app changing. So
    the address is the artifact id, and the runtime is *derived* here rather
    than baked into the pin — that is what stops a stale port from becoming the
    identity of an app.
    """
    from flow_sdk.builtin.artifact import Artifact  # noqa: PLC0415
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415
    from flow_sdk.builtin.faas.micro_app import MicroApp  # noqa: PLC0415

    if not is_valid_entity_id(artifact_id):
        raise InvalidDisplayTarget(f"Invalid artifact_id: {artifact_id!r}")

    # All three reads key off the same artifact id, so nothing here waits on
    # anything else — this resolve sits in front of every app display.
    artifact, deployment, micro_app = await asyncio.gather(
        Artifact.get_by_id(artifact_id),
        Deployment.get_one({"artifact_id": artifact_id}),
        MicroApp.get_by_artifact_id(artifact_id),
    )
    if artifact is None:
        raise DisplayTargetNotFound(f"Artifact not found: {artifact_id}")

    port = deployment.runtime_port if deployment is not None else None

    payload: dict = {
        "kind": DisplayTargetKind.APP,
        "artifact_id": artifact_id,
        "typeid": f"{Artifact.get_type()}-{artifact_id}",
        "name": artifact.name,
        "runtime": "dev" if port else ("served" if micro_app is not None else "unbuilt"),
    }
    if port:
        payload["port"] = port
    if micro_app is not None:
        payload["micro_app_id"] = micro_app.id
    return payload


def _folder_main_files() -> dict[str, str]:
    """Main-file name → record type, for folder-layout types.

    Derived from the type registry (``TypeInfo.main_layout == "folder"`` +
    ``main_file``, e.g. skill→SKILL.md, whiteboard→WHITE_BOARD.md) so a new
    folder-asset type resolves here without touching the display layer.
    Recomputed per call — 75-type walk is trivial and stays correct across
    late registrations.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    out: dict[str, str] = {}
    for type_name in SchemaRegistry.get_all_types():
        ti = SchemaRegistry.get(type_name)
        main_file = getattr(ti, "main_file", None)
        if getattr(ti, "main_layout", None) == "folder" and main_file:
            out[main_file] = type_name
    return out


def _claude_subdir_file_types() -> dict[str, str]:
    """``.claude/<subdir>`` → record type, for file-layout types (e.g. agent).

    Constrained to ``.claude/``-rooted subdirs on purpose: broader
    ``main_subdir`` values (``docs`` etc.) are not unambiguous type claims.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    out: dict[str, str] = {}
    for type_name in SchemaRegistry.get_all_types():
        ti = SchemaRegistry.get(type_name)
        subdir = getattr(ti, "main_subdir", None) or ""
        if getattr(ti, "main_layout", None) != "folder" and subdir.startswith(".claude/"):
            out[subdir] = type_name
    return out


def _asset_lookup_paths(resolved: str) -> list[str]:
    """Paths to try against ``asset_ref``, in order.

    Folder-asset awareness: a folder-layout entity's ``asset_ref`` is its
    FOLDER, so showing the main file (``SKILL.md`` / ``WHITE_BOARD.md`` / …)
    must also try the parent directory.
    """
    from pathlib import Path  # noqa: PLC0415

    p = Path(resolved)
    if p.name in _folder_main_files():
        return [resolved, str(p.parent)]
    return [resolved]


def _typed_asset_shape(resolved: str) -> tuple[str | None, str]:
    """Infer (record_type, discovery_path) from a path's shape, or (None, path).

    Only shapes the type registry declares unambiguously are inferred — these
    drive the targeted fresh-asset discovery above: a folder type's main file
    (or a dir containing one), ``.md`` files under a ``.claude/<subdir>`` a
    file type claims (e.g. ``.claude/agents``), and markdown docs under a docs
    root. Generic project-root markdown remains a raw VFS file until indexed.
    """
    from pathlib import Path  # noqa: PLC0415

    p = Path(resolved)
    folder_mains = _folder_main_files()
    if p.name in folder_mains:
        return folder_mains[p.name], str(p.parent)
    if p.is_dir():
        for main_file, type_name in folder_mains.items():
            if (p / main_file).exists():
                return type_name, resolved
    if p.suffix == ".md":
        parent = str(p.parent).replace("\\", "/")
        for subdir, type_name in _claude_subdir_file_types().items():
            if parent.endswith("/" + subdir):
                return type_name, resolved
        if _is_docs_markdown_path(p):
            if p.name == "index.md" and _has_markdown_index_frontmatter(p):
                return "markdown_index", resolved
            return "markdown", resolved
    return None, resolved


def _is_docs_markdown_path(path: "Path") -> bool:
    """True when an explicit ``.md`` path belongs to a docs root."""
    if path.suffix.lower() != ".md":
        return False
    try:
        resolved = path.resolve()
    except OSError:
        resolved = path.absolute()

    # Fast path for the common agent-created project docs layout:
    # <project>/docs/foo.md.
    if "docs" in resolved.parts:
        return True

    # Keep parity with the markdown indexer's configured search roots.
    try:
        from flow_sdk.fs_store.operations.markdown_dirs import doc_search_dirs  # noqa: PLC0415

        for root in doc_search_dirs():
            try:
                resolved.relative_to(root)
            except ValueError:
                continue
            return True
    except Exception:
        pass
    return False


def _has_markdown_index_frontmatter(path: "Path") -> bool:
    """Detect generated ``index.md`` files without parsing arbitrary markdown."""
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")[:4096]
    except OSError:
        return False
    if not text.startswith("---"):
        return False
    end = text.find("\n---", 3)
    if end < 0:
        return False
    frontmatter = text[3:end]
    for raw in frontmatter.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, value = line.split(":", 1)
        if key.strip() == "type":
            return value.strip().strip("\"'") == "markdown_index"
    return False


def entity_target(type_name: str, entity_id: str, *, name: str | None = None) -> dict:
    """An ENTITY DisplayTarget payload from a bare (type, id) — no entity load.

    The single builder of the entity-target shape; ``_entity_payload`` is the
    entity-in-hand convenience over it. ``name`` rides along so downstream
    consumers (e.g. auto-bookmark titles) get a human label without a re-fetch."""
    return {
        "kind": DisplayTargetKind.ENTITY,
        "typeid": f"{type_name}-{entity_id}",
        "type": type_name,
        "id": entity_id,
        "name": name or None,
    }


async def dock_target(address: str) -> dict:
    """A DOCK DisplayTarget payload from a ``<viewType>[/<pointer>][?<opts>]``
    address — the screen form.

    This is the only target kind that can name a view with no entity behind it,
    which is what lets an agent open Events or Preferences at all. Validation is
    entirely ``dock_address``'s table (pinned to the frontend by
    ``tests/fixtures/dock_address_contract.json``), so the rules cannot drift
    from what the UI will actually accept:

    * unknown view, or a view with no ``VIEWER_REGISTRY`` row (the retired
      aliases, and the folded-away ``skills`` / ``session`` / ``atlas``) →
      ``InvalidDisplayTarget``. Those still DECODE — history is forever — but
      they are never a destination;
    * a RETIRED view forwards first (``environment`` → ``credentials/environment``)
      rather than erroring, so an address saved before the retirement still opens;
    * a required pointer that is missing → ``InvalidDisplayTarget``;
    * a pointer shaped like a TypeId is looked up, so ``conversation/<bogus>``
      fails here instead of opening a dock that renders a load error. A
      grammar-only view (``events``) never touches the DB.

    The address is carried as the FRONTEND's own field names (``view_type`` /
    ``pointer`` / ``options`` / ``page``) so the client builds its DockPointer
    without re-parsing. Per the module's standing rule the payload carries the
    ADDRESS, never a baked URL.
    """
    from flow_sdk.core import dock_address as da  # noqa: PLC0415

    raw = (address or "").strip()
    if not raw:
        raise InvalidDisplayTarget("Empty dock address")

    # Accept a full path too, so a pasted URL works as well as a bare address.
    parsed = da.parse_dock_url(raw if raw.startswith("/") else f"/dock/{raw.lstrip('/')}")
    if parsed is None:
        # Name the actual problem — an agent reads this string and retries on it.
        head = raw.lstrip("/").split("?", 1)[0].split("/", 1)[0]
        if da.parse_view_type(head) is None:
            raise InvalidDisplayTarget(
                f"Unknown view '{head}'. Run `flow schema views` for the list."
            )
        raise InvalidDisplayTarget(f"Not a dock address: {address!r}")

    view, pointer = da.normalize_retired(parsed.view_type, parsed.pointer)
    meta = da.VIEW_META[view]
    if not meta.addressable:
        raise InvalidDisplayTarget(
            f"View '{view.value}' is not addressable (it decodes for history only)"
        )
    if meta.pointer is da.PointerRequirement.REQUIRED and not pointer:
        raise InvalidDisplayTarget(f"View '{view.value}' requires a pointer")

    await _assert_pointer_entity_exists(view, pointer)

    # Empty optionals are OMITTED, not sent as null: persistence drops null
    # values from ``context_data``, so a payload carrying them would not survive
    # the round trip byte-for-byte and `last_shown` would differ from the
    # response the caller just got. Fewer keys, same information.
    payload: dict = {
        "kind": DisplayTargetKind.DOCK,
        "view_type": view.value,
        "page": parsed.page.value,
    }
    if pointer:
        payload["pointer"] = pointer
    if parsed.options:
        payload["options"] = dict(parsed.options)
    return payload


async def _assert_pointer_entity_exists(view, pointer: str | None) -> None:
    """Raise ``DisplayTargetNotFound`` when an entity-backed pointer names nothing.

    Only the FIRST pointer segment is considered, and only in the two shapes
    that actually carry an entity:

    * a BARE id on a view whose name IS an entity type — ``conversation/<id>``,
      ``spec/<id>``, ``plan/<id>``. This is the common case, and note the type
      comes from the VIEW, not from the pointer;
    * an explicit ``<type>-<id>`` TypeId — ``agentic_process-<id>``.

    Every other pointer shape is grammar the view owns (``list/skill``,
    ``graph/eng.db``, ``editor/markdown/typeid/...``, a file path) and is left
    alone rather than guessed at. Guessing wrong would turn a working address
    into a spurious 404, which is worse than letting the view render its own
    not-found state.
    """
    if not pointer:
        return
    head = pointer.split("/", 1)[0]
    if not head:
        return

    tid = None
    if is_valid_entity_id(head):
        # Bare id: the VIEW names the type, when it names one at all.
        from flow_sdk.schema.types import EntityType  # noqa: PLC0415

        try:
            EntityType(view.value)
        except ValueError:
            return  # a bare id on a non-entity view — not ours to resolve
        tid = TypeId(f"{view.value}-{head}")
    else:
        try:
            candidate = TypeId(head)
        except (ValueError, IndexError):
            return
        if candidate.id and is_valid_entity_id(candidate.id):
            tid = candidate
    if tid is None:
        return

    try:
        entity = await Entity.get_by_typeid(tid)
    except ValueError:
        entity = None  # unknown type collapses to "not found", as elsewhere here
    if entity is None:
        raise DisplayTargetNotFound(f"Entity not found: {tid}")


def shell_target(shell: Entity) -> dict:
    """A SHELL DisplayTarget payload — an address for a live terminal.

    Unlike every other kind this is not something the display *renders*: the FE
    opens the shell's dock, which a mounted vibe workspace adopts as a child tab
    (see ``isAdoptableChildDock``). One hosting mechanism, shared with the
    terminal a guided journey opens. ``workdir`` rides along so a caller can
    label the terminal without re-fetching it."""
    return {
        "kind": DisplayTargetKind.SHELL,
        "typeid": f"shell-{shell.id}",
        "type": "shell",
        "id": str(shell.id),
        "name": getattr(shell, "name", None) or None,
        "workdir": getattr(shell, "workdir", None) or None,
    }


def _entity_payload(entity: Entity) -> dict:
    return entity_target(
        entity.get_type(),
        entity.id,
        name=getattr(entity, "name", None) or getattr(entity, "title", None) or None,
    )


def dock_url(target: dict, *, port: int, host: str = "localhost") -> str | None:
    """The absolute asset-editor deep link for a resolved display target.

    The one Python owner of the URL grammar
    ``/dock/assets/editor/<editor>/typeid/<type>-<id>``, whose other owner is
    ``assetEditorPointer`` in ts_sdk/src/APIEntity.ts (the two editor maps are
    pinned by tests/fixtures/asset_editor_contract.json).

    ``None`` — not an exception — for every address this grammar does not
    cover: an entity whose type has no asset editor, and the SHELL / WEBAPP /
    APP / VFS kinds, which have their own pointer forms owned elsewhere.
    Inventing a segment for those would put a second, wrong owner of each
    grammar on the backend.

    ``port`` is a parameter rather than read from instance settings so this
    stays a pure function — and so its caller is forced to decide *which* port,
    which matters: the UI is served by Vite on a different port than the API in
    every dev instance.
    """
    from flow_sdk.core.asset_editor import editor_for_type  # noqa: PLC0415

    if target.get("kind") != DisplayTargetKind.ENTITY:
        return None
    typeid = target.get("typeid")
    editor = editor_for_type(str(target.get("type") or ""))
    if not typeid or editor is None:
        return None
    return f"http://{host}:{port}/dock/assets/editor/{editor.value}/typeid/{typeid}"


def hub_asset_url(target: dict, *, hub_origin: str, project_id: str) -> str | None:
    """The HUB's project-rebased asset-editor URL for a resolved display target.

    ``<hub_origin>/dock/hub/project/<project_id>/editor/<editor>/typeid/<type>-<id>``

    Its other owner is ``hubProjectAssetDock`` in ui/src/lib/hub-page-url.ts
    (``rebaseAssetsOntoProject ∘ forAssetEditorByTypeId ∘ withPage(HUB)``); the
    two are pinned by the ``hub_url_cases`` rows in
    tests/fixtures/asset_editor_contract.json.

    **The project rebase is mandatory, not cosmetic.** A bare
    ``/dock/assets/editor/...`` on a hub-only server is redirected to
    ``/dock/hub/home`` (ui/src/navigation/supported-pages.ts), because the hub
    does not serve the ``desk`` page — so the un-rebased form silently lands the
    reviewer on a home screen instead of the document.

    ``None`` for the same reasons as :func:`dock_url`, plus a missing origin or
    project id. Callers must treat that as "there is no reviewer link", never
    as a URL to guess at.
    """
    from flow_sdk.core.asset_editor import editor_for_type  # noqa: PLC0415

    if not hub_origin or not project_id:
        return None
    if target.get("kind") != DisplayTargetKind.ENTITY:
        return None
    typeid = target.get("typeid")
    editor = editor_for_type(str(target.get("type") or ""))
    if not typeid or editor is None:
        return None
    origin = hub_origin.rstrip("/")
    return f"{origin}/dock/hub/project/{project_id}/editor/{editor.value}/typeid/{typeid}"
