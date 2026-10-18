"""Put mockify's kinds and its two datasets into the MOCK project (never the repo), under its namespace.

Usage: python -I install_data.py <project root> [--force]

- copies ``schema/agentic-assets/data_schema/mockify`` to ``<project>/agentic-assets/data_schema/mockify``
  with its ``"ns"`` set to the project's own (two projects never define one kind twice);
- writes ``<project>/agentic-assets/dataset/mocks/dataset.json`` (rows: ``mockify.mock``) and
  ``.../mock-feedback/dataset.json`` (rows: ``mockify.feedback``), the kinds written in full;
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
SCHEMA_SRC = SKILL / "schema" / "agentic-assets" / "data_schema" / "mockify"
DATASETS = {
    "mocks": ("Mocks", "One row per clickable journey mock (mockify); key = the mock's slug.", "mockify.mock"),
    "mock-feedback": ("Mock feedback",
                      "One row per comment a reviewer left on a mock screen (mockify); key = <mock>-<step>-<id>.",
                      "mockify.feedback"),
}


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


def install(root: Path, force: bool = False) -> dict:
    """Put the kinds and the two datasets into ``root`` (the mock project). Raises ValueError with no ``ns``."""
    manifest = root / "agentic-assets" / "project_manifest" / "project_manifest.json"
    try:
        ns = json.loads(manifest.read_text(encoding="utf-8")).get("ns")
    except (OSError, ValueError):
        ns = None
    if not ns:
        raise ValueError(f"no `ns` in {manifest}")

    schema_dst = root / "agentic-assets" / "data_schema" / "mockify"
    wrote = []
    if force or not schema_dst.exists():
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
    return {
        "ns": ns, "wrote": wrote,
        "kinds": {k: f"--{ns}--.mockify.{k}" for k in ("mock", "step", "decision", "anchor", "feedback")},
        "next": [
            f'flow schema apply "{root / "agentic-assets" / "data_schema"}"',
            f'flow record index "{datasets / "mocks"}" --types dataset',
            f'flow record index "{datasets / "mock-feedback"}" --types dataset',
        ],
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Install mockify's kinds and datasets into the mock project.")
    ap.add_argument("root", help="the mock project root (scripts/mock_project.py ensure prints it)")
    ap.add_argument("--force", action="store_true", help="refresh the schema copy")
    args = ap.parse_args()
    try:
        out = install(Path(args.root).resolve(), args.force)
    except ValueError as exc:
        fail(f"{exc} -- make the mock project with scripts/mock_project.py ensure")
    print(json.dumps({"ok": True, **out}))


if __name__ == "__main__":
    main()
