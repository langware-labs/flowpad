"""Put chartit's kinds and its feedback dataset into a project, under THAT project's namespace.

Usage: python -I install_data.py <project root> [--force]

- copies ``schema/agentic-assets/data_schema/chartit`` to ``<project>/agentic-assets/data_schema/chartit``
  with its ``"ns"`` set to the project's own (two projects never define one kind twice);
- writes ``<project>/agentic-assets/dataset/chart-feedback/dataset.json`` (rows: ``chartit.feedback``),
  the kind written in full (charts themselves are Chart entities, not rows);
- leaves what is already there alone unless ``--force`` (the schema is refreshed then; datasets'
  rows are never touched -- rows go through the SDK / dm_ctl only).

Prints one JSON object with the next commands to run (``flow schema apply``, ``flow record index``).
The project's ``ns`` comes from ``agentic-assets/project_manifest/project_manifest.json``; with no
manifest or no ``ns`` it stops and says so (the data-management skill's schema mode writes one).
Standard library only.
"""

import argparse
import json
import shutil
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
SCHEMA_SRC = SKILL / "schema" / "agentic-assets" / "data_schema" / "chartit"
DATASETS = {
    "chart-feedback": ("Chart feedback",
                       "One row per comment a reviewer left on a chart (chartit); key = <chart>-<id>.",
                       "chartit.feedback"),
}
KINDS = ("sequence", "participant", "message", "feedback")


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


def main() -> None:
    ap = argparse.ArgumentParser(description="Install chartit's kinds and datasets into a project.")
    ap.add_argument("root", help="the project root")
    ap.add_argument("--force", action="store_true", help="refresh the schema copy")
    args = ap.parse_args()
    root = Path(args.root).resolve()
    manifest = root / "agentic-assets" / "project_manifest" / "project_manifest.json"
    try:
        ns = json.loads(manifest.read_text(encoding="utf-8")).get("ns")
    except (OSError, ValueError):
        ns = None
    if not ns:
        fail(f"no `ns` in {manifest} -- give the project a namespace first (data-management `schema` mode, Gate 1)")

    schema_dst = root / "agentic-assets" / "data_schema" / "chartit"
    wrote = []
    if args.force or not schema_dst.exists():
        if schema_dst.exists():
            shutil.rmtree(schema_dst)
        shutil.copytree(SCHEMA_SRC, schema_dst)
        group = schema_dst / "data_schema.json"
        doc = json.loads(group.read_text(encoding="utf-8"))
        doc["ns"] = ns
        group.write_text(json.dumps(doc) + "\n", encoding="utf-8")
        wrote.append(str(schema_dst))

    for slug, (title, description, kind) in DATASETS.items():
        manifest_path = root / "agentic-assets" / "dataset" / slug / "dataset.json"
        if manifest_path.exists():
            continue
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps({
            "metadata": {"title": title, "description": description, "data_layout": "io_folder",
                         "spec": {"rows": [{"input": f"--{ns}--.{kind}"}]}},
            "data": {},
        }, indent=2) + "\n", encoding="utf-8")
        wrote.append(str(manifest_path.parent))

    datasets = root / "agentic-assets" / "dataset"
    print(json.dumps({
        "ok": True, "ns": ns, "wrote": wrote,
        "kinds": {k: f"--{ns}--.chartit.{k}" for k in KINDS},
        "next": [
            f'flow schema apply "{root / "agentic-assets" / "data_schema"}"',
            f'flow record index "{datasets / "chart-feedback"}" --types dataset',
        ],
    }))


if __name__ == "__main__":
    main()
