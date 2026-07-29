"""Every seeded backend default agrees with the frontend registry.

``bootstrap.default_prefs`` and ``prefRegistry.ts`` are hand-maintained mirrors,
and there is no codegen between them. That is tolerable only because something
checks they agree — this is that check.

It matters more than a normal duplication: ``setup_desktop_filesystem`` writes
``default_prefs`` **only** when ``preferences.json`` is missing or is the previous
stub, so for every existing install the in-code default is the *effective*
default. A disagreement means the Preferences screen shows one value while the
backend acts on another, silently and permanently.

Deliberately generic rather than auto-index-specific: it covers the four
pre-existing mirrors (``indexer_backend``, the three folder-consent keys) at the
same cost as covering one.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.timeout(10)

_REGISTRY = Path(__file__).resolve().parents[2] / "ts_sdk/src/preferences/prefRegistry.ts"

# `[PrefKey.X]: { … defaultValue: <literal>, … }` — an inline registry entry.
_ENTRY = re.compile(
    r"\[PrefKey\.(?P<member>\w+)\]:\s*\{(?P<body>.*?)\n  \},", re.DOTALL
)
# `[PrefKey.X]: someFactory(...)` — an entry built by a helper (e.g. indexFolderPref).
_FACTORY_ENTRY = re.compile(r"\[PrefKey\.(?P<member>\w+)\]:\s*(?P<fn>[a-z]\w*)\(", re.MULTILINE)
_FACTORY_BODY = re.compile(
    r"function (?P<fn>\w+)\([^)]*\)[^{]*\{(?P<body>.*?)\n\}", re.DOTALL
)
_DEFAULT = re.compile(r"^\s*defaultValue:\s*(?P<value>.+?),\s*$", re.MULTILINE)
_MEMBER = re.compile(r"^\s*(?P<member>[A-Z][A-Z0-9_]*)\s*=\s*'(?P<key>preferences\.[^']+)'", re.MULTILINE)


def _ts_literal(raw: str):
    """Parse the small set of literals `defaultValue` actually uses."""
    raw = raw.strip()
    if raw in ("true", "false"):
        return raw == "true"
    if raw == "{}":
        return {}
    if raw.startswith(("'", '"')):
        return raw[1:-1]
    try:
        return int(raw)
    except ValueError:
        return raw  # a constant reference (e.g. DEFAULT_SOUND_KEY) — resolved below


def _enum_member_value(member: str) -> str | None:
    """The string value of a TS enum member, searched across the SDK source.

    Enum member names are distinctive enough to find by name alone, which avoids
    having to follow the registry's import graph.
    """
    pattern = re.compile(rf"^\s*{re.escape(member)}\s*=\s*'([^']*)',?\s*$", re.MULTILINE)
    for path in (_REGISTRY.parents[1]).rglob("*.ts"):
        hit = pattern.search(path.read_text(encoding="utf-8"))
        if hit:
            return hit.group(1)
    return None


def _registry_defaults() -> dict[str, object]:
    """`{dotted key: defaultValue}` scraped from the TS registry."""
    src = _REGISTRY.read_text(encoding="utf-8")
    member_to_key = {m["member"]: m["key"] for m in _MEMBER.finditer(src)}
    # Module-level `const NAME = 'value'` so a default that references one resolves.
    consts = dict(re.findall(r"^const (\w+) = '([^']*)';", src, re.MULTILINE))

    def _resolve(raw: str) -> object:
        value = _ts_literal(raw)
        if not isinstance(value, str):
            return value
        if value in consts:
            return consts[value]
        # `SomeEnum.MEMBER` — resolve to the member's string value, which is what
        # actually lands in preferences.json (e.g. TerminalType.BUILTIN_XTERM).
        if "." in value:
            member = value.rsplit(".", 1)[1]
            found = _enum_member_value(member)
            if found is not None:
                return found
        return value

    out: dict[str, object] = {}
    for entry in _ENTRY.finditer(src):
        key = member_to_key.get(entry["member"])
        default = _DEFAULT.search(entry["body"])
        if key is not None and default is not None:
            out[key] = _resolve(default["value"])

    # Entries produced by a factory (indexFolderPref) carry their default in the
    # factory body, not at the call site.
    factory_defaults = {
        f["fn"]: _DEFAULT.search(f["body"]) for f in _FACTORY_BODY.finditer(src)
    }
    for entry in _FACTORY_ENTRY.finditer(src):
        key = member_to_key.get(entry["member"])
        default = factory_defaults.get(entry["fn"])
        if key is not None and default is not None and key not in out:
            out[key] = _resolve(default["value"])
    return out


def test_registry_parse_found_the_entries() -> None:
    """Guard the scraper itself — a regex that silently matches nothing would make
    every assertion below vacuous."""
    defaults = _registry_defaults()
    assert len(defaults) > 20, f"only parsed {len(defaults)} registry entries"
    assert defaults["preferences.advanced.indexer_backend"] == "python"


def test_every_seeded_default_matches_the_registry() -> None:
    from flow_sdk.server.routes.bootstrap import setup_desktop_filesystem  # noqa: F401

    registry = _registry_defaults()
    seeded = _seeded_defaults()
    assert seeded, "could not read default_prefs out of bootstrap.py"

    missing = sorted(k for k in seeded if k not in registry)
    assert not missing, (
        f"seeded by the backend but absent from prefRegistry.ts: {missing}. "
        "A key the TS registry does not know is unreadable through "
        "usePreference/get — add it to PREF_REGISTRY."
    )

    mismatched = {
        k: (seeded[k], registry[k]) for k in seeded if seeded[k] != registry[k]
    }
    assert not mismatched, (
        "default disagrees between bootstrap.default_prefs and prefRegistry.ts "
        f"(backend, frontend): {mismatched}"
    )


def _seeded_defaults() -> dict[str, object]:
    """`default_prefs` from bootstrap.py, evaluated with its imported constants.

    Read out of the source rather than by calling ``setup_desktop_filesystem``,
    which would touch the real filesystem and the instance dir.
    """
    import flow_sdk.server.routes.bootstrap as boot

    src = Path(boot.__file__).read_text(encoding="utf-8")
    block = re.search(r"default_prefs = \{(?P<body>.*?)\n    \}", src, re.DOTALL)
    if block is None:
        return {}

    out: dict[str, object] = {}
    for line in block["body"].splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r'(?P<k>"[^"]+"|[A-Z_][A-Z0-9_]*)\s*:\s*(?P<v>.+),$', line)
        if not m:
            continue
        raw_k, raw_v = m["k"], m["v"].strip()
        key = raw_k.strip('"') if raw_k.startswith('"') else getattr(boot, raw_k, None)
        if not isinstance(key, str):
            continue
        if raw_v in ("True", "False"):
            value: object = raw_v == "True"
        elif raw_v == "{}":
            value = {}
        elif raw_v.startswith('"'):
            value = raw_v.strip('"')
        elif raw_v.lstrip("-").isdigit():
            value = int(raw_v)
        else:
            value = getattr(boot, raw_v, raw_v)
        out[key] = value
    return out
