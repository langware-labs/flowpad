"""Keep the filesystem asset SDK independent of application and index services."""

import ast
from importlib.util import resolve_name
from pathlib import Path


def test_asset_package_has_no_application_or_index_imports():
    root = Path(__file__).resolve().parents[3] / "flow_sdk" / "assets"
    forbidden = (
        "flow_sdk.builtin", "flow_sdk.core.entity", "flow_sdk.db",
        "flow_sdk.fs_store.indexer", "flow_sdk.models.entities",
        "flow_sdk.app", "flow_sdk.actions", "flow_sdk.server",
    )
    violations = []
    for path in sorted(root.rglob("*.py")):
        package = ".".join(("flow_sdk", "assets", *path.relative_to(root).parent.parts))
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                imports = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ""
                if node.level:
                    module = resolve_name("." * node.level + module, package)
                imports = [module, *(f"{module}.{alias.name}" for alias in node.names)]
            else:
                continue
            for imported in imports:
                if any(imported == prefix or imported.startswith(prefix + ".") for prefix in forbidden):
                    violations.append(f"{path.relative_to(root)}:{node.lineno}: {imported}")
    assert not violations, "Asset SDK crosses its filesystem boundary:\n" + "\n".join(violations)
