"""macOS-TCC / cross-OS special-folder indexing gate.

Reading anything under a macOS "protected" folder (Documents, Desktop,
Downloads, and the media library at Music/Movies/Pictures) trips a TCC consent
popup attributed to Flowpad. The indexer's folder walker recurses whatever roots
it's handed, so a project mounted inside one of those folders — or a stray
$HOME-ish root — gets walked at scan time and pops the prompt.

This module is the single decision point the root resolvers and the folder walk
consult before touching a path. It implements a per-folder tri-state consent
model persisted in the instance ``preferences.json`` (keys
``preferences.indexing.folders.<category>``):

    ask (== missing/None)  → don't walk yet; surface an in-app consent request
    skip                   → never walk
    allow                  → walk (the FIRST real read then trips ONE OS prompt,
                             which the user — having clicked "Index" — expects)
    denied                 → OS refused after allow; never walk, don't re-ask

Two folder KINDS:
  * TRISTATE — Documents / Desktop / Downloads: dev projects plausibly live
    here, so we ask.
  * HARDSKIP — the media library (Music / Movies / Pictures): an editor has no
    legitimate reason to index it, so it is NEVER walked and NEVER offered.

Cross-OS: the *mechanism* (states, decision) is uniform; only the folder PATHS
and whether the OS actually prompts differ. macOS prompts (TCC); Windows does
not, but gating still avoids OneDrive file-hydration + wasted walks; Linux is
perf-only. See ``_special_folders_for_home`` for per-OS path resolution.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from enum import Enum
from functools import lru_cache
from pathlib import Path

# ── persisted per-folder state (preferences.json values) ─────────────────────
STATE_ASK = "ask"      # default / missing — surface a consent request
STATE_SKIP = "skip"    # user declined — never walk
STATE_ALLOW = "allow"  # user approved — walk (one expected OS prompt on first read)
STATE_DENIED = "denied"  # OS refused a post-allow read — never walk, don't re-ask
_VALID_STATES = frozenset({STATE_ASK, STATE_SKIP, STATE_ALLOW, STATE_DENIED})

PREF_PREFIX = "preferences.indexing.folders."


class FolderKind(str, Enum):
    TRISTATE = "tristate"  # ask/skip/allow — Documents/Desktop/Downloads
    HARDSKIP = "hardskip"  # never walked, never offered — media library


class IndexDecision(str, Enum):
    WALK = "walk"  # index it
    SKIP = "skip"  # don't index (declined / denied / hard-skip / not-yet-allowed)
    ASK = "ask"    # don't index yet — a consent request should be surfaced


@dataclass(frozen=True)
class SpecialFolder:
    category: str          # stable cross-OS id: documents|desktop|downloads|media
    path: Path             # resolved absolute path
    kind: FolderKind
    os_prompts: bool       # True where the OS shows a consent dialog (macOS)


def _home() -> Path:
    """Instance user_home (sandboxed in tests), falling back to ``Path.home()``."""
    try:
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        return get_instance_settings().user_home
    except Exception:
        return Path.home()


def _win_dir(name: str, home: Path) -> Path:
    """Resolve a Windows user folder, honoring OneDrive Known-Folder redirection.

    A OneDrive-redirected Documents/Desktop/Pictures lives under ``%OneDrive%``;
    reading it can trigger silent file hydration, so we gate the redirected path
    when present. Falls back to ``%USERPROFILE%/<name>``.
    """
    onedrive = os.environ.get("OneDrive") or os.environ.get("OneDriveConsumer")
    if onedrive:
        cand = Path(onedrive) / name
        if cand.is_dir():
            return cand
    return home / name


@lru_cache(maxsize=8)
def _special_folders_for_home(home_str: str, platform: str) -> tuple[SpecialFolder, ...]:
    """Per-OS special-folder set for a given home (cached; home varies in tests).

    Paths are ``.resolve()``d ONCE here so ``classify_special_folder`` only has
    to resolve the candidate — not all six folders — on every call.
    """
    home = Path(home_str)
    tri = FolderKind.TRISTATE
    hard = FolderKind.HARDSKIP

    def sf(category: str, path: Path, kind: FolderKind, prompts: bool) -> SpecialFolder:
        try:
            path = path.resolve()
        except OSError:
            pass
        return SpecialFolder(category, path, kind, prompts)

    if platform == "darwin":
        return (
            sf("documents", home / "Documents", tri, True),
            sf("desktop", home / "Desktop", tri, True),
            sf("downloads", home / "Downloads", tri, True),
            # media library — hard-skip (Apple Music / kTCCServiceMediaLibrary)
            sf("media", home / "Music", hard, True),
            sf("media", home / "Movies", hard, True),
            sf("media", home / "Pictures", hard, True),
        )
    if platform == "win32":
        return (
            sf("documents", _win_dir("Documents", home), tri, False),
            sf("desktop", _win_dir("Desktop", home), tri, False),
            sf("downloads", _win_dir("Downloads", home), tri, False),
            sf("media", _win_dir("Pictures", home), hard, False),
            sf("media", _win_dir("Music", home), hard, False),
            sf("media", _win_dir("Videos", home), hard, False),
        )
    # Linux / other: XDG user dirs (best-effort), gate is perf-only.
    return (
        sf("documents", _xdg_dir("DOCUMENTS", home / "Documents"), tri, False),
        sf("desktop", _xdg_dir("DESKTOP", home / "Desktop"), tri, False),
        sf("downloads", _xdg_dir("DOWNLOAD", home / "Downloads"), tri, False),
        sf("media", _xdg_dir("PICTURES", home / "Pictures"), hard, False),
        sf("media", _xdg_dir("MUSIC", home / "Music"), hard, False),
        sf("media", _xdg_dir("VIDEOS", home / "Videos"), hard, False),
    )


def _xdg_dir(name: str, fallback: Path) -> Path:
    """Resolve an XDG user dir from the environment, else ``fallback``.

    Reads ``XDG_<name>_DIR`` (rare) — the full user-dirs.dirs parse isn't worth
    it for a perf-only gate; the fallback (~/<Name>) is correct on stock setups.
    """
    env = os.environ.get(f"XDG_{name}_DIR")
    if env:
        return Path(os.path.expandvars(env))
    return fallback


def special_folders() -> tuple[SpecialFolder, ...]:
    """The active special-folder set for the current instance + OS."""
    return _special_folders_for_home(str(_home().resolve()), sys.platform)


def classify_special_folder(path: str | Path) -> SpecialFolder | None:
    """Return the SpecialFolder ``path`` is AT or UNDER, else None.

    Any read of a descendant of a protected folder trips the OS prompt, so
    containment (not just equality) is the gate. Resolves both sides so
    ``/var`` vs ``/private/var`` (macOS) and symlinks don't produce false
    misses.
    """
    try:
        p = Path(path).resolve()
    except (OSError, ValueError):
        return None
    # sf.path is pre-resolved in _special_folders_for_home, so this is a pure
    # in-memory containment check (is_relative_to covers ``== or under``).
    return next((sf for sf in special_folders() if p.is_relative_to(sf.path)), None)


def folder_state(category: str) -> str:
    """Read the persisted tri-state for a category (default ``ask``)."""
    from flow_sdk.preferences import read_instance_pref  # noqa: PLC0415

    val = read_instance_pref(PREF_PREFIX + category, STATE_ASK)
    return val if val in _VALID_STATES else STATE_ASK


def _decision_for(sf: SpecialFolder | None, *, foreground: bool) -> IndexDecision:
    """Pure decision from an already-classified folder (no re-classify).

    - Not a special folder            → WALK (normal path).
    - Media (HARDSKIP)                → SKIP always (never indexed, never asked).
    - Foreground (explicit user open) → WALK (index the project the user opened;
      the single OS prompt then is expected). Applies to TRISTATE only.
    - TRISTATE background:
        allow            → WALK
        skip | denied    → SKIP
        ask (default)    → ASK (don't walk; caller surfaces a consent request)
    """
    if sf is None:
        return IndexDecision.WALK
    if sf.kind is FolderKind.HARDSKIP:
        return IndexDecision.SKIP
    if foreground:
        return IndexDecision.WALK
    state = folder_state(sf.category)
    if state == STATE_ALLOW:
        return IndexDecision.WALK
    if state in (STATE_SKIP, STATE_DENIED):
        return IndexDecision.SKIP
    return IndexDecision.ASK


def indexing_decision(path: str | Path, *, foreground: bool = False) -> IndexDecision:
    """WALK / SKIP / ASK for ``path`` (no side effects). See ``_decision_for``."""
    return _decision_for(classify_special_folder(path), foreground=foreground)


def gate_root(path: str | Path, *, foreground: bool = False) -> IndexDecision:
    """The single gate both root resolvers call.

    Classifies ``path`` ONCE, decides, and — when the folder is un-decided
    (ASK) — queues a consent request. Returns the decision; callers walk the
    root iff it is ``WALK``. Centralizes the "on ASK, queue a note" policy that
    was previously copy-pasted at each resolver.
    """
    sf = classify_special_folder(path)
    decision = _decision_for(sf, foreground=foreground)
    if decision is IndexDecision.ASK and sf is not None:
        note_consent_needed(sf, path)
    return decision


# ── consent event contract (shared with ts_sdk indexingConsent.ts) ───────────
CONSENT_EVENT_KIND = "index_folder_consent"


def consent_event(sf: SpecialFolder, sample_path: str | Path | None = None) -> dict:
    """Canonical "this special folder needs indexing consent" event.

    Emitted to the frontend (notification metadata / WS) when a background scan
    hits an ASK folder. The frontend renders an [Index] / [Skip] prompt whose
    actions write ``preferences.indexing.folders.<category>``. Kept a plain dict
    so both the Python emitter and the ts_sdk parser assert the SAME shape.
    """
    return {
        "kind": CONSENT_EVENT_KIND,
        "category": sf.category,
        "path": str(sf.path),
        "sample_path": str(sample_path) if sample_path else None,
        "os_prompts": sf.os_prompts,
    }


# In-process dedup queue of categories awaiting a consent request. Keyed by
# category so N projects under ~/Documents raise ONE ask, not N.
_pending_consent: dict[str, dict] = {}


def note_consent_needed(sf: SpecialFolder, sample_path: str | Path | None = None) -> None:
    """Record that ``sf`` needs a consent request (deduped by category)."""
    _pending_consent.setdefault(sf.category, consent_event(sf, sample_path))


def drain_pending_consent() -> list[dict]:
    """Return and clear the queued consent events (the emitter surfaces them)."""
    events = list(_pending_consent.values())
    _pending_consent.clear()
    return events


def set_folder_state(category: str, state: str) -> bool:
    """Persist a tri-state decision for ``category`` (the [Index]/[Skip] action)."""
    if state not in _VALID_STATES:
        raise ValueError(f"invalid folder state {state!r}")
    from flow_sdk.preferences import write_instance_pref  # noqa: PLC0415

    _pending_consent.pop(category, None)
    return write_instance_pref(PREF_PREFIX + category, state)


def mark_denied(path: str | Path) -> None:
    """Transition the folder containing ``path`` to ``denied`` after an OS refusal.

    Called when a post-``allow`` read raises PermissionError/EPERM — the OS
    overrode our consent. Prevents a re-read (and thus re-prompt) loop. No-op if
    ``path`` isn't under a tri-state special folder.
    """
    sf = classify_special_folder(path)
    if sf is not None and sf.kind is FolderKind.TRISTATE:
        set_folder_state(sf.category, STATE_DENIED)
