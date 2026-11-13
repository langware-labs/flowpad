"""The mock project: where every mock lives, OUTSIDE the repo -- and the one way a mock gets into the repo.

    $FLOWPAD_PYTHON mock_project.py ensure <repo root>
    $FLOWPAD_PYTHON mock_project.py save   <repo root> <mock slug>

``ensure`` makes (or finds) ``$TMPDIR/mockify/<repo folder name>/``: a Flowpad project of its own with the
namespace of its own (``mocks_<repo ns>``), mockify's kinds, the ``mocks`` and ``mock-feedback`` datasets, and -- under
``agentic-assets/webapp/mock-<slug>/`` -- every mock. It registers the project, applies the kinds and
indexes the datasets, and prints ``{root, project_id, ns}``. Nothing is written to the repo.

``save`` is what the journey bar's "Save to repo" asks for: it copies ONE mock into the repo as a
self-contained folder -- ``<repo>/agentic-assets/webapp/mock-<slug>/`` with the page, its assets, the
compiled tree it already carries (``MOCKIFY.tree``, so it navigates with no datasets) and ``mock.json``
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


def mock_ns(repo: Path) -> str:
    """The mock project's OWN namespace, ``mocks_<repo ns>``. Never the repo's: two roots claiming one namespace
    keep only one after a restart -- the repo -- and the mock project's kinds then go unregistered (400 on rows)."""
    try:
        ns = json.loads((repo / MANIFEST).read_text(encoding="utf-8")).get("ns")
    except (OSError, ValueError):
        ns = None
    return "mocks_" + (ns or re.sub(r"[^a-z0-9_]", "_", repo.name.lower()))


def flow(*args: str) -> dict:
    """A ``flow`` command on this instance (FLOW_INSTANCE is pinned for a worker); its JSON, or a failure."""
    done = subprocess.run(["flow", *args], capture_output=True, text=True)
    text = done.stdout
    try:   # the JSON answer, whatever log lines surround it
        return json.JSONDecoder().raw_decode(text[text.index("{"):])[0]
    except ValueError:
        return {"ok": False, "error": (done.stderr or done.stdout).strip()[-400:]}


def project_for(root: Path) -> str:
    """The Flowpad project mounted at ``root``: found, else registered."""
    from flow_sdk import local_client as lc  # noqa: PLC0415

    for project in lc.graph_get("project", {"match": {"fs_storage_mount_path": str(root)}}) or []:
        if Path(str(project.get("fs_storage_mount_path") or "")).resolve() == root:
            return str(project["id"])
    created = lc.graph_post("project", {"type": "project", "name": f"mocks · {root.name}", "fs_storage_mount_path": str(root)})
    return str(created["id"])


def stamp_kinds(root: Path, ns: str) -> None:
    """Flowpad re-reads a kind only when ITS file text changes. A kind's namespace comes from the enclosing folder and
    mockify.mock embeds mockify.step, so a namespace move or a changed step would leave the others compiled the old
    way (rows then refused, or a kind not found by its bare name). Stamping one hash of the namespace and every kind
    into each kind's description changes every file whenever any of it does.
    WORKAROUND: the server fix (declared.py rebuilds the kinds that refer to a changed kind, and re-reads on a
    namespace change) is in the repo but not yet in the released Flowpad this runs against. Once it ships, delete
    this function and the apply loop below: one `flow schema apply` is then enough."""
    import hashlib  # noqa: PLC0415
    kinds = sorted((root / "agentic-assets" / "data_schema").rglob("data_schema.json"))
    strip = lambda t: re.sub(r"\s*\[kinds [0-9a-f]+\]$", "", t)  # noqa: E731
    docs = {p: json.loads(p.read_text()) for p in kinds}
    h = hashlib.sha1((ns + "".join(json.dumps({**d, "description": strip(d.get("description", ""))}, sort_keys=True)
                                   for d in docs.values())).encode()).hexdigest()[:10]
    for p, d in docs.items():
        desc = strip(d.get("description", "")) + f" [kinds {h}]"
        if d.get("description") != desc:
            d["description"] = desc
            p.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n")


DM_CTL = HERE.parent.parent / "data-management" / "scripts" / "dm_ctl.py"
DATASETS = ("mocks", "mock-feedback")


def read_rows(root: Path) -> dict:
    """``{dataset: [{key, input}]}`` as Flowpad reads them now -- taken BEFORE a namespace move, which hides them."""
    from flow_sdk import local_client as lc  # noqa: PLC0415

    got = {}
    for name in DATASETS:
        for d in lc.graph_get("dataset", {"match": {"asset_ref": str(root / "agentic-assets" / "dataset" / name)}}) or []:
            rows = (lc.graph_get(f"dataset/{d['id']}/rows") or {}).get("rows") or []
            got[name] = [{"key": r["key"], "input": r["input"]} for r in rows if r.get("key")]
    return got


def carry_rows(root: Path, before: dict, old_ns: str, new_ns: str) -> int:
    """Put back, under the new namespace, every row the move hid. References inside a row name the old kinds too."""
    after = read_rows(root)
    moved = 0
    for name, rows in before.items():
        have = {r["key"] for r in after.get(name, [])}
        lost = [json.loads(json.dumps(r).replace(f"--{old_ns}--", f"--{new_ns}--")) for r in rows if r["key"] not in have]
        if not lost:
            continue
        done = subprocess.run([sys.executable, str(DM_CTL), "ds-put-many", str(root / "agentic-assets" / "dataset" / name),
                               json.dumps(lost)], capture_output=True, text=True)
        if '"ok": true' not in done.stdout:
            fail(f"could not carry {len(lost)} {name} row(s) to {new_ns}: {(done.stdout or done.stderr)[-300:]}")
        moved += len(lost)
    return moved


def ensure(repo: Path) -> None:
    root = mock_root(repo)
    manifest = root / MANIFEST
    try:
        doc = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        doc = {"schema": 1, "requires": {}, "entries": []}
    old_ns, new_ns = doc.get("ns"), mock_ns(repo)
    moved = bool(old_ns) and old_ns != new_ns   # MIGRATION: a mock project made under another namespace (the repo's)
    before = read_rows(root) if moved else {}   # read while the rows are still visible under the old kind names
    if old_ns != new_ns:
        doc["ns"] = new_ns
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps(doc, indent=2) + "\n")
    (root / "agentic-assets" / "webapp").mkdir(parents=True, exist_ok=True)
    project_id = project_for(root)
    installed = install(root, force=True)   # the kinds follow the skill: a field added since is picked up
    stamp_kinds(root, new_ns)
    # Until clean: a kind that names another (mock -> tree -> screen -> action) may compile before it, so a pass
    # can leave some for the next. Stop when a pass fixes nothing more -- what is left then is a real error.
    left = float("inf")
    while True:
        applied = flow("schema", "apply", str(root / "agentic-assets" / "data_schema"))
        bad = [k["kind"] for k in applied.get("schemas") or [] if k.get("status") != "ok"]
        if not bad or len(bad) >= left:
            break
        left = len(bad)
    if not applied.get("ok") or bad:
        fail(f"flow schema apply failed: {applied.get('error') or bad or applied}")
    indexed = flow("record", "index", str(root / "agentic-assets" / "dataset"), "--types", "dataset")   # both datasets
    per = (indexed.get("per_type") or {}).get("dataset") or {}
    if not indexed.get("ok") or per.get("errors") or not (per.get("indexed") or per.get("skipped")):   # skipped = unchanged
        fail(f"indexing the datasets failed: {indexed.get('error') or indexed}")
    carried = carry_rows(root, before, old_ns, new_ns)   # 0 when nothing moved
    out(root=str(root), project_id=project_id, ns=installed["ns"], carried_rows=carried, repo=str(repo),
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
    # The saved page navigates on its own -- it carries its compiled tree (MOCKIFY.tree). It only lets go of the
    # mock project: no datasets there, so feedback is off.
    page = dst / "index.html"
    html = page.read_text(encoding="utf-8")
    html, n = re.subn(r'(window\.MOCKIFY = \{"key": "[^"]*", "project": )"[^"]*"', r"\1null", html, count=1)
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
