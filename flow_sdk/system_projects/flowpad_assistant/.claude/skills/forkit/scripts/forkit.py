"""forkit: put a list of issues into the forkit project and serve the app that works them in forks.

Usage: "$FLOWPAD_PYTHON" -I forkit.py <issues.json>

issues.json: {"root": "<agentic_process id>", "title": "...", "slug"?: "...",
              "issues": [{"id": "60", "title": "...", "desc"?: "...", "prompt"?: "..."}]}

- The forkit project lives at ``$FORKIT_HOME`` (default ``<workspace root>/forkit``, e.g. ``~/Flowpad workspace/forkit``), a Flowpad project of its own with its
  own namespace; its ``issues`` dataset holds every run's rows (``forkit.issue``, key ``<slug>--<issue id>``).
- Re-running a slug keeps each issue's status and fork; issues no longer listed are removed.
- The app is copied to ``<home>/agentic-assets/webapp/forkit-<slug>/`` and served; prints ``{ok, typeid, app_url}``.
Forks are NOT made here: the app makes one the first time an issue is opened.
"""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
DM_CTL = SKILL.parent / "data-management" / "scripts" / "dm_ctl.py"
NS = "forkit_runs"
KIND = f"--{NS}--.forkit.issue"


def out(**data) -> None:
    print(json.dumps({"ok": True, **data}))


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


def flow(*args: str, cwd: Path | None = None) -> dict:
    done = subprocess.run(["flow", *args], capture_output=True, text=True, cwd=cwd)
    text = done.stdout
    try:
        return json.JSONDecoder().raw_decode(text[text.index("{"):])[0]
    except ValueError:
        return {"ok": False, "error": (done.stderr or done.stdout).strip()[-400:]}


def dm(*args: str) -> dict:
    done = subprocess.run([sys.executable, str(DM_CTL), *args], capture_output=True, text=True)
    try:
        return json.loads(done.stdout)
    except ValueError:
        return {"ok": False, "error": (done.stderr or done.stdout).strip()[-400:]}


def project_for(root: Path) -> str:
    from flow_sdk import local_client as lc  # noqa: PLC0415

    for project in lc.graph_get("project", {"match": {"fs_storage_mount_path": str(root)}}) or []:
        if Path(str(project.get("fs_storage_mount_path") or "")).resolve() == root:
            return str(project["id"])
    created = lc.graph_post("project", {"type": "project", "name": "forkit", "fs_storage_mount_path": str(root)})
    return str(created["id"])


def ensure_project(home: Path) -> str:
    """The forkit project: manifest (own ns), the forkit kinds, the ``issues`` dataset; applied and indexed."""
    manifest = home / "agentic-assets" / "project_manifest" / "project_manifest.json"
    if not manifest.exists():
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps({"schema": 1, "ns": NS, "requires": {}, "entries": []}, indent=2) + "\n")
    project_id = project_for(home)
    schema_dst = home / "agentic-assets" / "data_schema" / "forkit"
    if schema_dst.exists():
        shutil.rmtree(schema_dst)
    shutil.copytree(SKILL / "schema" / "agentic-assets" / "data_schema" / "forkit", schema_dst)
    group = schema_dst / "data_schema.json"
    group.write_text(json.dumps({**json.loads(group.read_text()), "ns": NS}) + "\n")
    ds = home / "agentic-assets" / "dataset" / "issues" / "dataset.json"
    if not ds.exists():
        ds.parent.mkdir(parents=True, exist_ok=True)
        ds.write_text(json.dumps({"metadata": {"title": "forkit issues", "description": "One row per issue of a forkit run.",
                                               "data_layout": "io_folder", "spec": {"rows": [{"input": KIND}]}},
                                  "data": {}}, indent=2) + "\n")
    applied = flow("schema", "apply", str(home / "agentic-assets" / "data_schema"))
    bad = [k.get("kind") for k in applied.get("schemas") or [] if k.get("status") != "ok"]
    if not applied.get("ok") or bad:
        fail(f"flow schema apply failed: {applied.get('error') or bad or applied}")
    indexed = flow("record", "index", str(ds.parent), "--types", "dataset")
    if not indexed.get("ok"):
        fail(f"indexing the issues dataset failed: {indexed.get('error') or indexed}")
    return project_id


def prompt_for(issue: dict) -> str:
    return (issue.get("prompt") or
            f"forkit: work ONLY issue #{issue['id']}: {issue['title']}.\n{issue.get('desc') or ''}\n"
            "You are a fork of the session that found it; everything you know about it is in this conversation. "
            "Diagnose it and propose the fix; follow the project's rules on what needs the user's approval.").strip()


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: forkit.py <issues.json>")
    spec = json.loads(Path(sys.argv[1]).read_text())
    root, issues = spec.get("root"), spec.get("issues") or []
    if not root or not issues:
        fail("issues.json needs `root` (an agentic_process id) and a non-empty `issues` list")
    ids = [str(i.get("id") or "") for i in issues]
    if "" in ids or len(set(ids)) != len(ids) or any(not i.get("title") for i in issues):
        fail("every issue needs a unique `id` and a `title`")
    title = spec.get("title") or "forkit"
    slug = spec.get("slug") or re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40] or "forkit"

    from flow_sdk import local_client as lc  # noqa: PLC0415
    proc = lc.graph_get(f"agentic_process/{root}")
    if not proc or not proc.get("session_id"):
        fail(f"root {root} is not an agentic process with a session to fork")
    if proc.get("hub_route"):
        fail(f"root {root} runs on another machine (hub_route); open forkit on the machine that runs it")

    # NOT under ~/.flow: that is Flowpad's own state, never a project, so a restart would drop the forkit kind.
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    home = Path(os.environ.get("FORKIT_HOME") or get_instance_settings().workspace_root / "forkit").resolve()
    project_id = ensure_project(home)
    dataset = home / "agentic-assets" / "dataset" / "issues"

    have = {r["key"]: r for r in (dm("ds-rows", str(dataset), "--match", json.dumps({"input.run": slug})).get("rows") or [])}
    rows, expected = [], {}
    for n, issue in enumerate(issues):
        key = f"{slug}--{re.sub(r'[^a-z0-9_-]+', '-', str(issue['id']).lower())}"
        old = (have.get(key) or {}).get("input") or {}
        rows.append({"key": key, "input": {
            "run": slug, "id": str(issue["id"]), "title": issue["title"], "desc": issue.get("desc") or None,
            "prompt": prompt_for(issue), "root": root, "order": n,
            "status": old.get("status") or "open", "process_id": old.get("process_id") or None}})
        if key in have:
            expected[key] = have[key]["version"]
    put = dm("ds-put-many", str(dataset), json.dumps(rows), *(["--expected", json.dumps(expected)] if expected else []))
    if not put.get("ok"):
        fail(f"writing the issues failed: {put.get('error') or put}")
    gone = [k for k in have if k not in {r["key"] for r in rows}]
    if gone:
        dm("ds-delete", str(dataset), *gone)

    app = home / "agentic-assets" / "webapp" / (slug if slug.startswith("forkit") else f"forkit-{slug}")
    app.mkdir(parents=True, exist_ok=True)
    for f in (SKILL / "app").iterdir():
        shutil.copy2(f, app / f.name)
    (app / "webapp.json").write_text(json.dumps({"name": f"forkit-{slug}", "title": f"forkit — {title}",
                                                 "description": f"{len(issues)} issues, forked from {root}.",
                                                 "build": "."}) + "\n")
    (app / "config.js").write_text("window.FORKIT = " + json.dumps(
        {"run": slug, "title": title, "root": root, "project": project_id, "kind": KIND,
         "dataset": ((dm("ds-find", "--", KIND).get("datasets") or [{}])[0]).get("id")}) + ";\n")
    served = flow("app", "serve", f"forkit — {title}", "--no-show", cwd=app)
    if not served.get("ok"):
        fail(f"flow app serve failed: {served.get('error') or served}")
    ep = served.get("endpoint") or {}
    out(slug=slug, issues=len(issues), project_id=project_id, app=str(app),
        typeid=(served.get("shown") or {}).get("typeid") or f"micro_app-{(served.get('webapp') or {}).get('id')}",
        app_url=f"/api/v1/graph/service_endpoint/{ep.get('id')}/service/{ep.get('route')}/")


if __name__ == "__main__":
    main()
