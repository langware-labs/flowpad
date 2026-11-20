"""forkit: write a list of issues as rows and make the one page that works them in forks.

Usage: "$FLOWPAD_PYTHON" -I forkit.py <issues.json>

issues.json: {"root": "<agentic_process id>", "title": "...", "slug"?: "...",
              "issues": [{"id": "60", "title": "...", "desc"?: "...", "prompt"?: "..."}]}

- Rows are ``forkit.issue`` (a kind Flowpad ships), in the ``issues`` dataset of the forkit project at ``$FORKIT_HOME``
  (default ``<workspace root>/forkit``); key ``<slug>--<issue id>``.
- Re-running a slug keeps each issue's status and fork; issues no longer listed are removed.
- The page is ``<home>/forkit-<slug>.html`` (the skill's ``forkit.html`` with the run filled in); prints ``{ok, page}``.
Forks are NOT made here: the page makes one when the person approves the issue's first message.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
DM_CTL = SKILL.parent / "data-management" / "scripts" / "dm_ctl.py"
KIND = "forkit.issue"


def out(**data) -> None:
    print(json.dumps({"ok": True, **data}))


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


def flow(*args: str) -> dict:
    done = subprocess.run(["flow", *args], capture_output=True, text=True)
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


def ensure_project(home: Path) -> None:
    """The forkit project and its ``issues`` dataset (rows of the shipped ``forkit.issue``), indexed."""
    home.mkdir(parents=True, exist_ok=True)
    project_for(home)
    ds = home / "agentic-assets" / "dataset" / "issues" / "dataset.json"
    if not ds.exists():
        ds.parent.mkdir(parents=True, exist_ok=True)
        ds.write_text(json.dumps({"metadata": {"title": "forkit issues", "description": "One row per issue of a forkit run.",
                                               "data_layout": "io_folder", "spec": {"rows": [{"input": KIND}]}},
                                  "data": {}}, indent=2) + "\n")
    indexed = flow("record", "index", str(ds.parent), "--types", "dataset")
    if not indexed.get("ok"):
        fail(f"indexing the issues dataset failed: {indexed.get('error') or indexed}")


def prompt_for(issue: dict) -> str:
    """The fork's first message, shown to the person for approval: the fork already holds the whole conversation."""
    return (issue.get("prompt") or f"Lets focus on issue:{issue['id']}").strip()


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
    ensure_project(home)
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

    found = dm("ds-find", "--", KIND).get("datasets") or []
    mine = next((d for d in found if Path(str(d.get("asset_ref") or "")).resolve() == dataset), None)
    config = {"run": slug, "title": title, "root": root, "kind": KIND, "dataset": (mine or (found or [{}])[0]).get("id")}
    page = home / (f"{slug}.html" if slug.startswith("forkit") else f"forkit-{slug}.html")
    page.write_text((SKILL / "forkit.html").read_text().replace("/*FORKIT_CONFIG*/{}", json.dumps(config)))
    out(slug=slug, issues=len(issues), page=str(page))


if __name__ == "__main__":
    main()
