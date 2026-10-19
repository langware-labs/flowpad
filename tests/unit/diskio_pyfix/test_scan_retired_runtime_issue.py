"""A data driver folder still carrying a retired runtime file is a scan ISSUE.

``scan_repo_tree`` built that issue positionally; ``AssetScanIssue`` is a pydantic
spec, so the call raised ``TypeError`` and one such folder aborted the scan of
the whole repo tree — every other asset in it went unindexed.
"""

import json
from pathlib import Path

import pytest

from flow_sdk.assets.placement import AGENTIC_ASSETS_DIR
from flow_sdk.assets.scanning import scan_repo_tree
from flow_sdk.fs_store.schema_registry import SchemaRegistry


def _driver(repo: Path, name: str, *extra: str) -> Path:
    folder = repo / AGENTIC_ASSETS_DIR / "data_driver" / name
    folder.mkdir(parents=True)
    (folder / "data_driver.json").write_text(json.dumps({"type": "data_driver", "name": name}))
    for file in extra:
        (folder / file).write_text("# retired\n")
    return folder


@pytest.mark.parametrize("retired", ["fetch.py", "FETCH.md"])
def test_a_retired_runtime_file_is_reported_not_raised(tmp_path: Path, retired: str):
    infos = SchemaRegistry.repo_family_to_info()
    assert retired in {name for name, _ in infos["data_driver"].retired_files}
    old = _driver(tmp_path, "old_feed", retired)
    good = _driver(tmp_path, "good_feed")

    result = scan_repo_tree(tmp_path, infos)

    [issue] = result.issues
    assert (issue.path, issue.type_name, issue.retired) == (old, "data_driver", retired)
    assert issue.message.startswith(f"{retired} belongs to a retired data_driver runtime")
    # The retired folder is not handed on as an asset, and its sibling still is.
    assert [candidate.path for candidate in result.candidates] == [good]
