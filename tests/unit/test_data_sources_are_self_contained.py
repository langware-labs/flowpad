"""A data source is self-contained in its asset folder (CLAUDE.md, "Data sources are self-contained
assets").

Outside ``agentic-assets/data_driver/<name>/`` only generic machinery may exist. This scans the
application tiers for the traces a provider leaves when its KNOWLEDGE escapes its folder: an import
of provider code, a shipped source's class name, a query filtering rows by one source's name, or a
per-source table row. It also requires every shipped asset to carry its own ``source.py``.

Naming an asset to USE it — ``StreamInbox(provider="agentmail")``, ``DataDriver.loaded("cloud_email")`` — is
not knowledge about it, the way opening a skill by name is not; what the machinery then needs, it
asks the source for. ``EXCEPTIONS`` is the user's to grant.
"""
from __future__ import annotations

import ast
import re
import subprocess
from functools import lru_cache
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ASSETS_REL = "flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver"
ASSETS = REPO / ASSETS_REL
#: The application tiers. Other assets (skills, agents) are content, not machinery — they may talk
#: about Slack; the engine may not.
SCANNED = ("flow_sdk", "ts_sdk/src", "ui/src")
SUFFIXES = (".py", ".ts", ".tsx")
IGNORED = ("flow_sdk/system_projects/", "flow_sdk/server/static/")
#: Source names that are also ordinary words the engine uses in their own sense (an ``"agent"``
#: key in a run record is not the agent source). Only the table-row trace skips them.
ORDINARY_WORDS = frozenset({"agent", "folder", "git", "helpdesk"})   # helpdesk: Flowpad's own portal too

#: Approved exceptions — ``{repo-relative path: "YYYY-MM-DD — approved by <who>: <why>"}``.
#: Only the user grants one.
EXCEPTIONS: dict[str, str] = {}


@lru_cache(maxsize=1)
def shipped_names() -> tuple[str, ...]:
    return tuple(sorted(p.name for p in ASSETS.iterdir() if (p / "data_driver.json").is_file()))


@lru_cache(maxsize=1)
def row_names() -> tuple[str, ...]:
    """The names a per-source table row could be keyed on."""
    return tuple(name for name in shipped_names() if name not in ORDINARY_WORDS)


@lru_cache(maxsize=1)
def source_class_names() -> frozenset[str]:
    """Every ``*Source`` class a shipped source defines."""
    names: set[str] = set()
    for path in ASSETS.glob("*/*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        names |= {node.name for node in tree.body if isinstance(node, ast.ClassDef) and node.name.endswith("Source")}
    return frozenset(names)


@lru_cache(maxsize=1)
def traces() -> tuple[tuple[str, re.Pattern], ...]:
    names = "|".join(map(re.escape, shipped_names()))
    rows = "|".join(map(re.escape, row_names()))
    return (
        ("imports provider code", re.compile(rf"sources[./]providers|flowpad_source_(?:{names})_")),
        ("names a source class", re.compile(rf"\b(?:{'|'.join(sorted(source_class_names()))})\b")),
        ("filters rows by a source name", re.compile(rf"""["']provider["']\s*:\s*["'](?:{names})["']""")),
        ("a per-source table row", re.compile(rf"""^\s*["']?(?:{rows})["']?\s*:\s*["'`]""", re.M)),
        ("a constant naming a source", re.compile(
            rf"""^\s*[A-Z0-9_]*(?:PROVIDER|SOURCE|DRIVER)[A-Z0-9_]*\s*(?::[^=\n]+)?=\s*["'](?:{rows})["']""", re.M)),
        ("a provider's message spec", re.compile(rf"\b(?:{rows.replace('_', '')})MessageSpec\b", re.I)),
    )


def provider_named_modules() -> list[str]:
    """Modules of the engine named after a driver (``sources/gmail_send.py``): provider code by name."""
    pathspecs = [f"{tier}/*{suffix}" for tier in SCANNED for suffix in SUFFIXES] + [f":!{p}" for p in IGNORED]
    listed = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", *pathspecs],
                            cwd=REPO, capture_output=True, text=True).stdout.splitlines()
    names = row_names()
    return [rel for rel in listed if (REPO / rel).is_file() and ((stem := Path(rel).stem.lower()) in names
            or any(stem.startswith((f"{n}_", f"{n}-")) for n in names))]


def _candidates() -> list[str]:
    """Files that could carry a trace, by a fixed-string pre-pass (``git grep -F``, tracked and
    untracked): reading every file of the tiers in Python is most of a second, and few files hold
    any of these strings at all. The exact traces then run on the candidates only."""
    needles = ["sources/providers", "sources.providers", "flowpad_source_", "provider", *source_class_names(),
               "MessageSpec", *(f'= "{name}"' for name in row_names()), *(f"= '{name}'" for name in row_names()),
               # a table row, quoted (`"gmail":`) or an unquoted TS key (`gmail: 'Mail'`)
               *(f"{name}{q}:" for name in row_names() for q in ("\"", "'", ""))]
    pathspecs = [f"{tier}/*{suffix}" for tier in SCANNED for suffix in SUFFIXES] + [f":!{p}" for p in IGNORED]
    listed = subprocess.run(
        ["git", "grep", "-l", "-I", "--untracked", "-F", *(arg for n in needles for arg in ("-e", n)), "--", *pathspecs],
        cwd=REPO, capture_output=True, text=True,
    ).stdout.splitlines()
    return [f for f in listed if (REPO / f).is_file()]


#: A literal every match of that trace contains: a file without it skips the (slower) regex.
_MUST_CONTAIN = {"a provider's message spec": "MessageSpec", "a constant naming a source": "="}


def _first_trace(rel: str, text: str) -> str:
    hits = [(match.start(), label) for label, pattern in traces()
            if _MUST_CONTAIN.get(label, "") in text and (match := pattern.search(text))]
    if not hits:
        return ""
    start, label = min(hits)
    line = text.count("\n", 0, start) + 1
    return f"{rel}:{line} {label}: {text.splitlines()[line - 1].strip()[:120]}"


@lru_cache(maxsize=1)
def offenders() -> dict[str, str]:
    """``{path: first trace}`` for every place that carries provider knowledge outside its asset."""
    found: dict[str, str] = {
        f"{ASSETS_REL}/{name}": f"{ASSETS_REL}/{name} has no source.py of its own"
        for name in shipped_names()
        if not (ASSETS / name / "source.py").is_file()
    }
    for rel in provider_named_modules():
        found[rel] = f"{rel} is named after a data driver"
    for rel in _candidates():
        if trace := _first_trace(rel, (REPO / rel).read_text(encoding="utf-8", errors="replace")):
            found[rel] = trace
    return found


def test_no_provider_knowledge_outside_asset_folders():
    unexpected = {path: trace for path, trace in offenders().items() if path not in EXCEPTIONS}
    assert not unexpected, (
        "provider knowledge escaped its data_source asset folder — move it into the source's folder "
        "(a manifest field or a classmethod the machinery asks), or ask the user for an exception:\n  "
        + "\n  ".join(sorted(unexpected.values()))
    )


def test_every_exception_carries_its_approval():
    for path, why in EXCEPTIONS.items():
        assert re.match(r"^\d{4}-\d{2}-\d{2} — approved by .+: .+", why), f"{path}: {why!r} must say when, who and why"


def test_a_credential_one_driver_owns_lives_in_that_drivers_folder():
    """Everything one driver needs lives in its folder — its credential too. A shipped credential that
    exactly one driver names (``auth.credential``) is that driver's, so it sits at
    ``data_driver/<d>/agentic-assets/credential/<name>/``; one several drivers (or none) name — a model
    key that funds agents, say — stays in the shipped project's top-level ``credential/``."""
    import json

    owners: dict[str, list[str]] = {}
    for manifest in ASSETS.glob("*/data_driver.json"):
        credential = ((json.loads(manifest.read_text()).get("auth") or {}).get("credential") or "").strip()
        if credential:
            owners.setdefault(credential, []).append(manifest.parent.name)
    top_level = {p.parent.name for p in (ASSETS.parent / "credential").glob("*/credential.json")}
    misplaced = {name: drivers[0] for name, drivers in owners.items() if len(drivers) == 1 and name in top_level}
    assert not misplaced, f"move each into its driver's agentic-assets/credential/: {misplaced}"
    missing = {
        name: drivers[0] for name, drivers in owners.items()
        if len(drivers) == 1 and not (ASSETS / drivers[0] / "agentic-assets" / "credential" / name / "credential.json").is_file()
    }
    assert not missing, f"a driver names a credential its folder does not carry: {missing}"


# ── secret managers: the same rule, for ``agentic-assets/secret_manager/<name>/`` ─────────────────
SECRET_MANAGERS_REL = "flow_sdk/system_projects/flowpad_assistant/agentic-assets/secret_manager"
SECRET_MANAGERS = REPO / SECRET_MANAGERS_REL


@lru_cache(maxsize=1)
def secret_manager_names() -> tuple[str, ...]:
    return tuple(sorted(p.name for p in SECRET_MANAGERS.iterdir() if (p / "secret_manager.json").is_file()))


@lru_cache(maxsize=1)
def secret_manager_offenders() -> dict[str, str]:
    """A manager without its own ``store.py``; an import of a manager's package or a reference to
    one of its classes outside its folder. No module-NAME trace: a manager is named for a vendor
    (``gcp``), and the SDK has its own vendor clients (``secrets/gcp_secret_manager.py``, which the
    ``gcp`` manager wraps) — what may not escape is the manager's code."""
    names = secret_manager_names()
    found: dict[str, str] = {
        f"{SECRET_MANAGERS_REL}/{n}": f"{SECRET_MANAGERS_REL}/{n} has no store.py of its own"
        for n in names if not (SECRET_MANAGERS / n / "store.py").is_file()
    }
    classes: set[str] = set()
    for path in SECRET_MANAGERS.glob("*/*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        classes |= {node.name for node in tree.body if isinstance(node, ast.ClassDef)}
    pathspecs = [f"{tier}/*{suffix}" for tier in SCANNED for suffix in SUFFIXES] + [f":!{p}" for p in IGNORED]
    listed = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", *pathspecs],
                            cwd=REPO, capture_output=True, text=True).stdout.splitlines()
    pattern = re.compile(rf"flowpad_secret_manager_|\b(?:{'|'.join(map(re.escape, sorted(classes))) or '(?!)'})\b")
    for rel in listed:
        if rel in found or not (REPO / rel).is_file():
            continue
        text = (REPO / rel).read_text(encoding="utf-8", errors="replace")
        if (match := pattern.search(text)) and not rel.endswith("flow_sdk/secrets/managers.py"):
            line = text.count("\n", 0, match.start()) + 1
            found[rel] = f"{rel}:{line} names a secret manager's code: {text.splitlines()[line - 1].strip()[:120]}"
    return found


def test_no_secret_manager_knowledge_outside_its_asset_folder():
    unexpected = {path: trace for path, trace in secret_manager_offenders().items() if path not in EXCEPTIONS}
    assert not unexpected, (
        "secret manager knowledge escaped its asset folder — move it into the manager's folder "
        "(secret_manager.json or its store.py), or ask the user for an exception:\n  "
        + "\n  ".join(sorted(unexpected.values()))
    )
