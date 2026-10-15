"""The mock project: where every mock lives, OUTSIDE the repo -- and the one way a mock gets into the repo.

    $FLOWPAD_PYTHON mock_project.py ensure <repo root>
    $FLOWPAD_PYTHON mock_project.py save   <repo root> <mock slug>

``ensure`` makes (or finds) ``$TMPDIR/mockify/<repo folder name>/``: a Flowpad project of its own with the
repo's namespace, mockify's kinds, the ``mocks`` and ``mock-feedback`` datasets, and -- under
``agentic-assets/webapp/mock-<slug>/`` -- every mock. It registers the project, applies the kinds and
indexes the datasets, and prints ``{root, project_id, ns}``. Nothing is written to the repo.

``save`` is what the journey bar's "Save to repo" asks for: it copies ONE mock into the repo as a
self-contained folder -- ``<repo>/agentic-assets/webapp/mock-<slug>/`` with the page, its assets, the
journey written into the page (``MOCKIFY.journey``, so it navigates with no datasets) and ``mock.json``
(the mock row's value). Its feedback, the datasets and the kinds stay in the mock project. Run it only
when the person pressed Save (or asked for it in words).

Run on Flowpad's interpreter ($FLOWPAD_PYTHON): it talks to the running Flowpad. One JSON object out.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from install_data import install  # noqa: E402

MANIFEST = Path("agentic-assets/project_manifest/project_manifest.json")


def out(**data) -> None:
    print(json.dumps({"ok": True, **data}))


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


def mock_root(repo: Path) -> Path:
    return Path(tempfile.gettempdir()).resolve() / "mockify" / repo.name


def repo_ns(repo: Path) -> str:
    """The repo's namespace (the mock project carries the same one: the repo itself never holds mockify's
    kinds, so they never meet), or one made from the folder name."""
    try:
        ns = json.loads((repo / MANIFEST).read_text(encoding="utf-8")).get("ns")
    except (OSError, ValueError):
        ns = None
    return ns or "mockify_" + re.sub(r"[^a-z0-9_]", "_", repo.name.lower())


def flow(*args: str) -> dict:
    """A ``flow`` command on this instance (FLOW_INSTANCE is pinned for a worker); its JSON, or a failure."""
    done = subprocess.run(["flow", *args], capture_output=True, text=True)
    try:
        return json.loads(done.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError):
        return {"ok": False, "error": (done.stderr or done.stdout).strip()[-400:]}


def project_for(root: Path) -> str:
    """The Flowpad project mounted at ``root``: found, else registered."""
    from flow_sdk import local_client as lc  # noqa: PLC0415

    for project in lc.graph_get("project", {"match": {"fs_storage_mount_path": str(root)}}) or []:
        if Path(str(project.get("fs_storage_mount_path") or "")).resolve() == root:
            return str(project["id"])
    created = lc.graph_post("project", {"type": "project", "name": f"mocks · {root.name}", "fs_storage_mount_path": str(root)})
    return str(created["id"])


def ensure(repo: Path) -> None:
    root = mock_root(repo)
    manifest = root / MANIFEST
    if not manifest.is_file():
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps({"schema": 1, "requires": {}, "ns": repo_ns(repo), "entries": []}, indent=2) + "\n")
    (root / "agentic-assets" / "webapp").mkdir(parents=True, exist_ok=True)
    project_id = project_for(root)
    installed = install(root, force=True)   # the kinds follow the skill: a field added since is picked up
    applied = flow("schema", "apply", str(root / "agentic-assets" / "data_schema"))
    if not applied.get("ok"):
        fail(f"flow schema apply failed: {applied.get('error') or applied}")
    indexed = flow("record", "index", str(root / "agentic-assets" / "dataset"), "--types", "dataset")   # both datasets
    if not indexed.get("ok"):
        fail(f"indexing the datasets failed: {indexed.get('error') or indexed}")
    out(root=str(root), project_id=project_id, ns=installed["ns"], repo=str(repo),
        mocks=str(root / "agentic-assets" / "dataset" / "mocks"),
        feedback=str(root / "agentic-assets" / "dataset" / "mock-feedback"),
        webapps=str(root / "agentic-assets" / "webapp"))


def save(repo: Path, slug: str) -> None:
    from flow_sdk import local_client as lc  # noqa: PLC0415

    root = mock_root(repo)
    src = root / "agentic-assets" / "webapp" / f"mock-{slug}"
    if not (src / "index.html").is_file():
        fail(f"no mock at {src}")
    mocks = lc.graph_get("dataset", {"match": {"asset_ref": str(root / "agentic-assets" / "dataset" / "mocks")}}) or []
    if not mocks:
        fail("the mock project has no mocks dataset (mock_project.py ensure)")
    found = lc.graph_get(f"dataset/{mocks[0]['id']}/rows", match=json.dumps({"key": slug})) or {}
    rows = found.get("rows") or []
    if not rows:
        fail(f"no mock row {slug!r}")
    value = rows[0]["input"]

    dst = repo / "agentic-assets" / "webapp" / f"mock-{slug}"
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    (dst / "mock.json").write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    # The saved page navigates on its own: the journey goes into MOCKIFY (the bar's offline copy).
    page = dst / "index.html"
    html = page.read_text(encoding="utf-8")
    offline = json.dumps({"key": slug, "project": None, "journey": value.get("journey", [])}, ensure_ascii=False)
    html, n = re.subn(r"window\.MOCKIFY\s*=\s*\{.*?\};(?=\s*(?:window\.|</script>))", lambda _m: f"window.MOCKIFY = {offline};", html, count=1)
    if not n:
        fail(f"{page} sets no window.MOCKIFY -- not a mockify page")
    page.write_text(html, encoding="utf-8")
    out(saved=str(dst), files=sorted(str(p.relative_to(repo)) for p in dst.rglob("*") if p.is_file())[:50])


def main() -> None:
    if len(sys.argv) < 3 or sys.argv[1] not in ("ensure", "save") or (sys.argv[1] == "save" and len(sys.argv) != 4):
        fail("usage: mock_project.py ensure <repo root> | save <repo root> <mock slug>")
    repo = Path(sys.argv[2]).resolve()
    if not repo.is_dir():
        fail(f"no folder {repo}")
    try:
        ensure(repo) if sys.argv[1] == "ensure" else save(repo, sys.argv[3])
    except Exception as exc:  # noqa: BLE001 -- one JSON answer, whatever went wrong
        fail(f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    main()
