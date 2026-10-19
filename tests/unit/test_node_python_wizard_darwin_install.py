"""The macOS install of Node.js / npm / Python in the llm-setup wizard must work on a Mac with no Homebrew.

A clean Mac has no ``brew`` (and Homebrew needs Apple's Command Line Tools first), so ``brew install node`` /
``brew install python3`` failed there. The commands now use Homebrew when it is present and otherwise install under
the user's home with no password: the official Node tarball (checksum-verified), or a uv-managed Python.

The real commands run here against stand-ins on PATH (``curl``, ``uname``, ``uv``, ``brew``), with HOME in a
temporary directory, so nothing is downloaded and nothing outside the test directory is touched.
"""

import hashlib
import io
import json
import stat
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

OPS = Path(__file__).resolve().parents[2] / "flow_sdk/system_projects/flowpad_assistant/agentic-assets/compute_op"
pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="a POSIX shell command for macOS")


def _op(name):
    return json.loads((OPS / name / "compute_op.json").read_text())


def _script(path: Path, body: str) -> None:
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def _node_tarball(version="v24.99.0", arch="arm64") -> tuple[str, bytes]:
    """A tiny stand-in for node-v24-darwin-<arch>.tar.gz: bin/node, and bin/npm + bin/npx as links to a script."""
    name = f"node-{version}-darwin-{arch}.tar.gz"
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for rel, body in (
            (f"node-{version}-darwin-{arch}/bin/node", f"#!/bin/sh\necho {version}\n"),
            (f"node-{version}-darwin-{arch}/bin/npm", "#!/bin/sh\necho 11.0.0\n"),
            (f"node-{version}-darwin-{arch}/bin/npx", "#!/bin/sh\necho 11.0.0\n"),
        ):
            data = body.encode()
            info = tarfile.TarInfo(rel)
            info.size, info.mode = len(data), 0o755
            tar.addfile(info, io.BytesIO(data))
    return name, buf.getvalue()


def _env(tmp_path, *, brew=False, arch="arm64", uv=False):
    home = tmp_path / "home"
    shims = tmp_path / "shims"
    web = tmp_path / "web"
    for d in (home, shims, web):
        d.mkdir(exist_ok=True)
    calls = tmp_path / "calls"
    calls.write_text("")
    # curl serves files out of `web` by their last URL segment, and records the URL.
    _script(
        shims / "curl",
        f'for a in "$@"; do case "$a" in http*) url="$a";; esac; done\n'
        f'out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done\n'
        f'echo "curl $url" >> "{calls}"\n'
        f'src="{web}/${{url##*/}}"\n'
        f'[ -f "$src" ] || exit 22\ncp "$src" "$out"\n',
    )
    _script(shims / "uname", f'[ "$1" = "-m" ] && echo {arch} || echo Darwin\n')
    if brew:
        _script(shims / "brew", f'echo "brew $*" >> "{calls}"\n')
    if uv:
        py = tmp_path / "uvpython/bin/python3.12"
        py.parent.mkdir(parents=True)
        _script(py, 'echo "Python 3.12.0"\n')
        _script(
            shims / "uv",
            f'echo "uv $*" >> "{calls}"\ncase "$1 $2" in "python find") echo "{py}";; esac\nexit 0\n',
        )
    return home, shims, web, calls


def _run(tmp_path, command, home, shims):
    return subprocess.run(
        ["/bin/sh", "-c", command],
        capture_output=True,
        text=True,
        timeout=60,
        env={"HOME": str(home), "PATH": f"{shims}:/usr/bin:/bin"},
    )


def _serve_node(web: Path, *, arch="arm64", corrupt=False):
    name, data = _node_tarball(arch=arch)
    (web / name).write_bytes(data)
    digest = "0" * 64 if corrupt else hashlib.sha256(data).hexdigest()
    other = f"{'f' * 64}  node-v24.99.0-darwin-{'x64' if arch == 'arm64' else 'arm64'}.tar.gz\n"
    (web / "SHASUMS256.txt").write_text(f"{other}{digest}  {name}\n{'e' * 64}  node-v24.99.0-linux-x64.tar.gz\n")


@pytest.mark.parametrize("op", ["node-on-path", "npm-on-path"])
@pytest.mark.parametrize(("machine", "arch"), [("arm64", "arm64"), ("x86_64", "x64")])
def test_node_installs_from_the_official_tarball_when_there_is_no_homebrew(tmp_path, op, machine, arch):
    home, shims, web, calls = _env(tmp_path, arch=machine)
    _serve_node(web, arch=arch)
    result = _run(tmp_path, _op(op)["exe_data"]["commands"]["darwin"], home, shims)
    assert result.returncode == 0, result.stderr
    for name in ("node", "npm", "npx"):
        assert (home / ".local/bin" / name).is_symlink(), f"{name} is linked into ~/.local/bin"
    assert subprocess.run([str(home / ".local/bin/node")], capture_output=True, text=True).stdout.strip() == "v24.99.0"
    assert "nodejs.org/dist/latest-v24.x/SHASUMS256.txt" in calls.read_text()
    assert f"darwin-{arch}.tar.gz" in calls.read_text(), "the build for THIS Mac's architecture was fetched"


def test_node_uses_homebrew_when_it_is_there(tmp_path):
    home, shims, web, calls = _env(tmp_path, brew=True)
    result = _run(tmp_path, _op("node-on-path")["exe_data"]["commands"]["darwin"], home, shims)
    assert result.returncode == 0
    assert "brew install node" in calls.read_text()
    assert "curl" not in calls.read_text(), "nothing is downloaded by hand when Homebrew can do it"


def test_a_download_that_does_not_match_its_checksum_is_not_installed(tmp_path):
    home, shims, web, _ = _env(tmp_path)
    _serve_node(web, corrupt=True)
    result = _run(tmp_path, _op("node-on-path")["exe_data"]["commands"]["darwin"], home, shims)
    assert result.returncode == 1
    assert "checksum" in result.stderr
    assert not (home / ".local/bin/node").exists()


def test_an_unknown_architecture_stops_with_a_message(tmp_path):
    home, shims, _web, _calls = _env(tmp_path, arch="ppc")
    result = _run(tmp_path, _op("node-on-path")["exe_data"]["commands"]["darwin"], home, shims)
    assert result.returncode == 1
    assert "Unsupported Mac architecture" in result.stderr


def test_a_release_with_no_build_for_this_mac_stops_with_a_message(tmp_path):
    home, shims, web, _calls = _env(tmp_path, arch="arm64")
    (web / "SHASUMS256.txt").write_text(f"{'a' * 64}  node-v24.99.0-linux-x64.tar.gz\n")
    result = _run(tmp_path, _op("node-on-path")["exe_data"]["commands"]["darwin"], home, shims)
    assert result.returncode == 1
    assert "No Node.js build" in result.stderr


def test_node_and_npm_run_the_same_command(tmp_path):
    """The wizard runs it once and both checks hold; the test machinery relies on the two being identical."""
    assert _op("node-on-path")["exe_data"]["commands"]["darwin"] == _op("npm-on-path")["exe_data"]["commands"]["darwin"]


def test_python_installs_through_uv_when_there_is_no_homebrew(tmp_path):
    home, shims, web, calls = _env(tmp_path, uv=True)
    result = _run(tmp_path, _op("python-on-path")["exe_data"]["commands"]["darwin"], home, shims)
    assert result.returncode == 0, result.stderr
    assert "uv python install 3.12" in calls.read_text()
    link = home / ".local/bin/python3"
    assert link.is_symlink()
    assert subprocess.run([str(link)], capture_output=True, text=True).stdout.strip() == "Python 3.12.0"


def test_python_uses_homebrew_when_it_is_there(tmp_path):
    home, shims, web, calls = _env(tmp_path, brew=True, uv=True)
    result = _run(tmp_path, _op("python-on-path")["exe_data"]["commands"]["darwin"], home, shims)
    assert result.returncode == 0
    assert "brew install python3" in calls.read_text()
    assert "uv " not in calls.read_text()


def test_python_without_homebrew_or_uv_says_so(tmp_path):
    home, shims, web, calls = _env(tmp_path)
    result = _run(tmp_path, _op("python-on-path")["exe_data"]["commands"]["darwin"], home, shims)
    assert result.returncode == 1
    assert "uv was not found" in result.stderr


@pytest.mark.parametrize(
    "op", ["node-on-path", "npm-on-path", "python-on-path", "ask-install-node", "ask-install-npm", "ask-install-python"]
)
def test_the_checks_look_in_the_directory_the_installs_link_into(op):
    check = _op(op)["completion_check"]["commands"]["darwin"]
    assert check.startswith('export PATH="$HOME/.local/bin:$PATH"; ')
