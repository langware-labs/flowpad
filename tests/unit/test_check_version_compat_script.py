"""scripts/check_version_compat.py -- the release gate for the desktop <-> backend contract.

The script runs in CI beside a checkout (no installed flowpad), so it loads the real contract
(``flow_sdk/utils/compat.py``) from its file instead of keeping a copy of the rules. These tests pin the
parts that decide whether a desktop release may be published: what it accepts as a candidate wheel, how it
reads a wheel's floor, and which release it picks.
"""

from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "check_version_compat.py"
HOST = "https://files.pythonhosted.org/packages/ab/cd"


_CONTRACT_MODULES = ("flow_sdk", "flow_sdk.utils", "flow_sdk.utils.compat", "flow_sdk.utils.semver")


@pytest.fixture(scope="module")
def gate():
    """The script, loaded as a module. It installs bare stand-ins for ``flow_sdk`` into ``sys.modules`` when
    the package is not imported yet (that is how it runs in CI); put ``sys.modules`` back afterwards so a
    stub can never leak into the rest of the session, whatever order the tests run in."""
    saved = {name: sys.modules.get(name) for name in _CONTRACT_MODULES}
    try:
        spec = importlib.util.spec_from_file_location("check_version_compat_under_test", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        for name, original in saved.items():
            if original is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original
    return module


def _wheel(compat_json: "str | None") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("flow_sdk/__init__.py", "")
        if compat_json is not None:
            zf.writestr("flow_sdk/compat.json", compat_json)
    return buf.getvalue()


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_it_runs_standalone_with_no_flowpad_imported():
    """CI runs it against a checkout: a fresh interpreter, the contract loaded from its file."""
    done = subprocess.run([sys.executable, "-I", str(SCRIPT)], capture_output=True, text=True, timeout=60)

    assert done.returncode == 0, done.stdout + done.stderr
    assert "satisfies the bundled desktop floor" in done.stdout


@pytest.mark.parametrize(
    ("url", "trusted"),
    [
        (f"{HOST}/flowpad-0.2.1-py3-none-any.whl", True),
        ("http://files.pythonhosted.org/x.whl", False),           # not https
        ("https://evil.example.com/flowpad.whl", False),          # not PyPI's file host
        ("https://files.pythonhosted.org.evil.com/x.whl", False),  # look-alike suffix
        ("https://user@evil.example.com/files.pythonhosted.org", False),
        (None, False),
        (123, False),
    ],
)
def test_only_pypis_https_file_host_is_trusted(gate, url, trusted):
    assert gate.trusted_wheel_url(url) is trusted


def test_a_wheels_floor_is_read_from_its_zip_member(gate, monkeypatch):
    for text, expected in ((json.dumps({"min_desktop_version": "0.2.60"}), "0.2.60"), ("{}", None), (None, None)):
        monkeypatch.setattr(gate.urllib.request, "urlopen", lambda url, timeout=0, _w=_wheel(text): _Response(_w))
        assert gate.wheel_min_desktop("u") == expected


def test_a_wheel_with_broken_metadata_is_an_error_not_legacy(gate, monkeypatch):
    monkeypatch.setattr(gate.urllib.request, "urlopen", lambda url, timeout=0: _Response(_wheel("not json")))

    with pytest.raises(gate.compat.CompatError):
        gate.wheel_min_desktop("u")


def _pypi(monkeypatch, gate, releases, floors):
    """PyPI's JSON document + each wheel's floor, without touching the network."""
    doc = json.dumps({"releases": releases}).encode()
    monkeypatch.setattr(gate.urllib.request, "urlopen", lambda url, timeout=0: _Response(doc))
    monkeypatch.setattr(gate, "wheel_min_desktop", lambda url: floors[url])


def _release(version, *, yanked=False, host=HOST, sdist_only=False):
    name = f"flowpad-{version}.tar.gz" if sdist_only else f"flowpad-{version}-py3-none-any.whl"
    return [{"filename": name, "url": f"{host}/{name}", "yanked": yanked}]


def test_it_picks_the_newest_release_both_floors_accept(gate, monkeypatch, capsys):
    releases = {"0.2.70": _release("0.2.70"), "0.2.65": _release("0.2.65"), "0.2.40": _release("0.2.40")}
    floors = {f"{HOST}/flowpad-0.2.70-py3-none-any.whl": "0.2.60", f"{HOST}/flowpad-0.2.65-py3-none-any.whl": "0.2.40"}
    _pypi(monkeypatch, gate, releases, floors)

    gate.resolve("0.2.45", "0.2.50")  # 0.2.40 is below the desktop's floor and never read; 0.2.70 needs desktop 0.2.60

    out = capsys.readouterr().out
    assert "resolves backend 0.2.65" in out
    assert "skip 0.2.70" in out and "requires Desktop 0.2.60" in out


def test_yanked_untrusted_and_wheelless_releases_are_never_candidates(gate, monkeypatch):
    releases = {
        "0.2.90": _release("0.2.90", yanked=True),
        "0.2.89": _release("0.2.89", host="https://evil.example.com/p"),
        "0.2.88": _release("0.2.88", sdist_only=True),
        "0.2.87": [],
        "0.2.30": _release("0.2.30"),
    }
    seen = []
    doc = json.dumps({"releases": releases}).encode()
    monkeypatch.setattr(gate.urllib.request, "urlopen", lambda url, timeout=0: _Response(doc))
    monkeypatch.setattr(gate, "wheel_min_desktop", lambda url: seen.append(url) or None)

    gate.resolve("0.2.45", "0.2.0")

    assert seen == [f"{HOST}/flowpad-0.2.30-py3-none-any.whl"]


def test_a_partly_yanked_release_is_read_through_its_unyanked_wheel(gate, monkeypatch):
    files = [
        {"filename": "flowpad-0.2.50-py3-none-any.whl", "url": f"{HOST}/yanked.whl", "yanked": True},
        {"filename": "flowpad-0.2.50-py2.py3-none-any.whl", "url": f"{HOST}/good.whl", "yanked": False},
    ]
    seen = []
    doc = json.dumps({"releases": {"0.2.50": files}}).encode()
    monkeypatch.setattr(gate.urllib.request, "urlopen", lambda url, timeout=0: _Response(doc))
    monkeypatch.setattr(gate, "wheel_min_desktop", lambda url: seen.append(url) or None)

    gate.resolve("0.2.45", "0.2.0")

    assert seen == [f"{HOST}/good.whl"]


def test_it_refuses_to_publish_when_no_release_is_compatible(gate, monkeypatch, capsys):
    releases = {"0.2.70": _release("0.2.70"), "0.2.65": _release("0.2.65")}
    floors = {f"{HOST}/flowpad-{v}-py3-none-any.whl": "9.9.9" for v in releases}
    _pypi(monkeypatch, gate, releases, floors)

    with pytest.raises(SystemExit) as stop:
        gate.resolve("0.2.45", "0.2.0")

    assert stop.value.code == 1
    assert "do not publish this desktop release" in capsys.readouterr().err


def test_an_unreadable_candidate_is_skipped_not_fatal(gate, monkeypatch, capsys):
    releases = {"0.2.70": _release("0.2.70"), "0.2.65": _release("0.2.65")}
    doc = json.dumps({"releases": releases}).encode()
    monkeypatch.setattr(gate.urllib.request, "urlopen", lambda url, timeout=0: _Response(doc))

    def floor(url):
        if "0.2.70" in url:
            raise OSError("connection reset")
        return None

    monkeypatch.setattr(gate, "wheel_min_desktop", floor)

    gate.resolve("0.2.45", "0.2.0")

    captured = capsys.readouterr()
    assert "skip 0.2.70" in captured.err and "resolves backend 0.2.65" in captured.out


def test_an_unparseable_desktop_version_is_a_usage_error(gate):
    with pytest.raises(SystemExit) as stop:
        gate.resolve("nonsense", "0.2.0")

    assert stop.value.code == 2


def test_the_failure_says_why_releases_were_excluded(gate, monkeypatch, capsys):
    """"No release satisfies the floor" was the message for four different causes; name the real ones."""
    releases = {
        "0.2.90": _release("0.2.90", yanked=True),
        "0.2.89": _release("0.2.89", host="https://evil.example.com/p"),
        "0.2.88": _release("0.2.88", sdist_only=True),
        "0.2.30": _release("0.2.30"),
    }
    doc = json.dumps({"releases": releases}).encode()
    monkeypatch.setattr(gate.urllib.request, "urlopen", lambda url, timeout=0: _Response(doc))

    with pytest.raises(SystemExit):
        gate.resolve("0.2.45", "0.2.50")

    err = capsys.readouterr().err
    assert "1 release(s) are below the desktop's floor 0.2.50" in err
    assert "1 release(s) have only yanked wheels" in err
    assert "1 release(s) have no wheel on files.pythonhosted.org" in err
    assert "1 release(s) have no wheel" in err


def test_no_stub_package_is_left_in_sys_modules(gate):
    """The script plants bare stand-ins for ``flow_sdk`` when the package is not imported yet; they must
    not outlive loading it. (A real package has a ``__file__``; the stand-in does not.)"""
    leaked = sys.modules.get("flow_sdk")

    assert leaked is None or getattr(leaked, "__file__", None), "a bare stub package leaked into sys.modules"


def test_no_stub_leaks_even_when_flow_sdk_was_not_imported_first():
    """``tests/conftest.py`` imports flow_sdk before any test runs, which hides the hazard. Run the check
    above with no conftest at all -- the condition the stubs exist for."""
    done = subprocess.run(
        [sys.executable, "-m", "pytest", "--noconftest", "-q", "-p", "no:cacheprovider",
         f"{Path(__file__)}::test_no_stub_package_is_left_in_sys_modules"],
        cwd=REPO, capture_output=True, text=True, timeout=60,
    )

    assert done.returncode == 0, done.stdout + done.stderr


def test_a_release_candidate_never_makes_a_desktop_releasable(gate, monkeypatch, capsys):
    """The desktop never installs an rc by itself, so the gate must not pass a desktop because of one."""
    seen = []
    releases = {"0.2.230rc1": _release("0.2.230rc1"), "0.2.223.dev1": _release("0.2.223.dev1"), "0.2.222": _release("0.2.222")}
    doc = json.dumps({"releases": releases}).encode()
    monkeypatch.setattr(gate.urllib.request, "urlopen", lambda url, timeout=0: _Response(doc))
    monkeypatch.setattr(gate, "wheel_min_desktop", lambda url: seen.append(url) or None)

    gate.resolve("0.2.45", "0.2.0")

    assert seen == [f"{HOST}/flowpad-0.2.222-py3-none-any.whl"], "only the final release was read"
    assert "resolves backend 0.2.222" in capsys.readouterr().out


def test_when_only_pre_releases_exist_the_failure_says_so(gate, monkeypatch, capsys):
    doc = json.dumps({"releases": {"0.2.230rc1": _release("0.2.230rc1"), "0.2.231a1": _release("0.2.231a1")}}).encode()
    monkeypatch.setattr(gate.urllib.request, "urlopen", lambda url, timeout=0: _Response(doc))

    with pytest.raises(SystemExit):
        gate.resolve("0.2.45", "0.2.0")

    assert "2 release(s) are pre-releases or tagged builds" in capsys.readouterr().err


# ── the gate checks the release ABOUT to be cut, and runs before anything expensive ──────────────────────

def test_it_validates_the_version_about_to_be_released_not_the_one_on_disk(gate, capsys):
    gate.validate_files("99.0.0")

    assert "backend 99.0.0 satisfies the bundled desktop floor" in capsys.readouterr().out


def test_a_release_below_the_floor_it_bundles_is_refused(gate, capsys):
    floor = gate.load_floor(gate.REPO / "electron" / "engine-compat.json", "min_backend_version")
    below = "0.0.1"
    assert gate.compat.meets_floor(below, floor) is False, "precondition: the shipped floor is above 0.0.1"

    with pytest.raises(SystemExit) as stop:
        gate.validate_files(below)

    assert stop.value.code == 1 and "below the desktop floor it bundles" in capsys.readouterr().err


def test_a_floor_raised_to_the_release_it_ships_in_passes_for_that_release(gate, monkeypatch):
    """The reason the gate takes the target version: raising min_backend_version to X in the PR that releases X
    must not be rejected because the version still on disk is X-1."""
    monkeypatch.setattr(gate, "load_floor", lambda path, key: "0.2.500" if key == "min_backend_version" else "0.2.0")

    gate.validate_files("0.2.500")
    with pytest.raises(SystemExit):
        gate.validate_files("0.2.499")


def test_an_unparseable_target_version_is_refused(gate):
    with pytest.raises(SystemExit) as stop:
        gate.validate_files("nonsense")

    assert stop.value.code == 1


def test_the_cli_takes_backend_version():
    for version, code in (("99.0.0", 0), ("0.0.1", 1)):
        done = subprocess.run([sys.executable, "-I", str(SCRIPT), "--backend-version", version], capture_output=True, text=True, timeout=60)
        assert done.returncode == code, (version, done.stdout + done.stderr)


def test_the_deploy_script_runs_the_gate_before_the_expensive_steps():
    """A failure must cost nothing: the gate precedes the test run, the remote flow-rs signing and the version write
    (it used to run after all three, wasting a signing run and leaving _version.py bumped but uncommitted)."""
    text = (REPO / "scripts" / "deploy_to_github.sh").read_text(encoding="utf-8")
    gate = text.index("check_version_compat.py --backend-version")
    for later in ("Running tests...", "Signing standalone flow-rs", "update_version_file \"$NEW_VERSION\""):
        assert gate < text.index(later), f"the gate must come before {later!r}"
    assert text.count("check_version_compat.py") == 1, "one call, at the start"
