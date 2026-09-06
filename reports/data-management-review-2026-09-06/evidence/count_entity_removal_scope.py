"""Measure the Entity-removal migration surface; does not estimate deletions."""

import ast
import hashlib
import io
import json
import subprocess
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
COUNTER = Path(__file__).with_name("count_sloc.py")
counter_tree = ast.parse(COUNTER.read_text())
counter_fn = next(
    node for node in counter_tree.body
    if isinstance(node, ast.FunctionDef) and node.name == "python_lines"
)
namespace = {"ast": ast, "io": io, "tokenize": tokenize}
exec(compile(ast.Module(body=[counter_fn], type_ignores=[]), str(COUNTER), "exec"), namespace)

paths = [
    "flow_sdk/core/entity/entity_model.py",
    "flow_sdk/db/db_entity.py",
    "flow_sdk/fs_store/fs_record.py",
    "flow_sdk/fs_store/serializer/record.py",
    "flow_sdk/fs_store/record_list.py",
    "flow_sdk/fs_store/record_query.py",
]
files = [
    {
        "file": name,
        "sloc": len(namespace["python_lines"](ROOT / name)[0]),
        "sha256": hashlib.sha256((ROOT / name).read_bytes()).hexdigest(),
    }
    for name in paths
]
supporting_paths = [
    "flow_sdk/db/drivers/db_base_record.py",
    "flow_sdk/fs_store/serializer/db.py",
]
supporting_files = [
    {
        "file": name,
        "sloc": len(namespace["python_lines"](ROOT / name)[0]),
        "sha256": hashlib.sha256((ROOT / name).read_bytes()).hexdigest(),
    }
    for name in supporting_paths
]
subclasses = []
imports = set()
for path in sorted((ROOT / "flow_sdk").rglob("*.py")):
    if "static" in path.parts:
        continue
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and any(
            isinstance(base, ast.Name) and base.id == "Entity" for base in node.bases
        ):
            subclasses.append({"file": str(path.relative_to(ROOT)), "line": node.lineno, "class": node.name})
        if isinstance(node, ast.ImportFrom) and node.module == "flow_sdk.core.entity.entity_model":
            if any(alias.name == "Entity" for alias in node.names):
                imports.add(str(path.relative_to(ROOT)))

print(json.dumps({
    "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
    "scope": "Six current Python source files, including uncommitted contents; not a net deletion estimate",
    "sloc_definition": "Physical code lines excluding blanks, comments and Python docstrings; runtime strings count",
    "files": files,
    "total_sloc": sum(entry["sloc"] for entry in files),
    "supporting_files": supporting_files,
    "combined_total_sloc": sum(entry["sloc"] for entry in files + supporting_files),
    "inventory_caveat": "Static named-base/direct-import inventory, includes benchmark fixtures; not all registered types or consumers",
    "direct_entity_subclasses": subclasses,
    "direct_entity_subclass_count": len(subclasses),
    "direct_entity_import_files": sorted(imports),
    "direct_entity_import_file_count": len(imports),
}, indent=2))
