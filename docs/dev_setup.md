# Developer Setup

## PyCharm Import Resolution

### Problem

PyCharm may show unresolved import errors (red underlines) for `flow_sdk.*` imports even though the code runs correctly. For example:

```python
from flow_sdk.mcp_server.mcp_api import flow_ping  # PyCharm: "Cannot find reference"
```

No code changes are needed — the imports work at runtime.

### Root Cause

The project uses a **non-standard package layout** with a custom setuptools `package_dir` mapping in `setup.py`. When installed in editable mode (`uv sync` / `pip install -e .`), setuptools generates a custom `_EditableFinder` meta path hook in `site-packages/` that dynamically rewrites import paths at runtime:

| Import path | Actual filesystem path |
|---|---|
| `flow_sdk` | `flow-sdk/python/_pkg_init/` |
| `flow_sdk.mcp_server` | `flow-sdk/python/mcp_server/` |
| `flow_sdk.fs_records` | `flow-sdk/python/fs_records/` |
| `flow_sdk.utils` | `flow-sdk/python/utils/` |
| `mcp_server` (bare) | `flow-sdk/python/mcp_server/` |

Key details:

- There is **no real `flow_sdk/` directory** that contains these subpackages as subdirectories.
- `flow_sdk` points to `_pkg_init/`, while `flow_sdk.mcp_server` points to a **sibling** directory (`mcp_server/`), not a child of `_pkg_init/`.
- The mapping is handled entirely by `_EditableFinder` (in `.venv/lib/python3.*/site-packages/__editable___flowpad_*_finder.py`), which hooks into `sys.meta_path`.
- PyCharm's static analyzer cannot follow this dynamic indirection — it only sees filesystem paths and standard package layouts.

### How to Verify

The imports resolve correctly at runtime:

```bash
uv run python -c "import flow_sdk.mcp_server; print(flow_sdk.mcp_server.__file__)"
# -> flow-sdk/python/mcp_server/__init__.py
```

### Workaround

Mark `flow-sdk/python` as a **Sources Root** in PyCharm. This resolves bare imports (`from mcp_server.mcp_api import ...`) but does not fully fix `flow_sdk.*` prefixed imports due to the virtual package layout described above.

The remaining red underlines on `flow_sdk.*` imports are cosmetic — they do not affect runtime behavior, tests, or builds.
