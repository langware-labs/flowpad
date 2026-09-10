"""The zombie project: a record with no usable path must not invent a mount.

`~/Flowpad workspace/flowpad-oss` kept reappearing however often it was deleted,
for a checkout that actually lives at ~/Documents/dev/flowpad-oss. The project's
own fs-record carries `cwd: None` (verified on the prod instance), and
`Project.from_record`'s path priority is
`fs_storage_mount_path or cwd or real_path`, then `name` only if absolute.
With every one of those empty, the record falls through to a plain construction
from `name`, where `set_fs_storage_mount_path`'s "simple name" branch roots the
project at `AGENT_MOUNT_FOLDER/<name>` — a folder the user never chose. The next
PTY spawn runs `os.makedirs(cwd)` and the folder is back.

A record is an INPUT here, not the component under test, so it is a real
`FSRecord` (its `meta_dict` drops None values, which is exactly how the prod
record's absent `cwd` presents). Nothing about `Project` is mocked.
"""

from pathlib import Path

import pytest

from flow_sdk.builtin.project import Project
from flow_sdk.config import AGENT_MOUNT_FOLDER
from flow_sdk.fs_store.fs_record import FSRecord

# Resolve both sides: `canonical_posix_path` resolves symlinks on the mount it
# stores (on macOS /var -> /private/var), so an unresolved workspace root would
# never match a stored mount's parents and the assert would silently pass.
WORKSPACE = Path(AGENT_MOUNT_FOLDER).resolve()


async def _mount_from_record(record: FSRecord) -> str:
    """Where `Project.from_record` actually lands this record."""
    project = await Project.from_record(record, notify=False)
    return str(project.fs_storage_mount_path) if project else ""


@pytest.mark.asyncio
async def test_record_without_a_path_does_not_invent_a_workspace_mount():
    """A project record carrying only a bare name must not be relocated.

    This is the zombie: prod's `flowpad-oss` record has `cwd: None`, so
    from_record finds no path and falls through to a construction from `name`.
    """
    record = FSRecord(type="project", name="flowpad-oss")

    mount = await _mount_from_record(record)

    assert WORKSPACE not in Path(mount).resolve().parents, (
        f"zombie: a record with no cwd was rooted at {mount!r}, inside the agent "
        f"workspace {str(WORKSPACE)!r}, instead of being rejected as locationless"
    )


@pytest.mark.asyncio
async def test_record_with_a_cwd_is_left_where_it_lives(tmp_path):
    """The control: with `cwd` present the real location survives."""
    real = tmp_path / "Documents" / "dev" / "flowpad-oss"
    real.mkdir(parents=True)
    record = FSRecord(type="project", name="flowpad-oss", cwd=str(real))

    assert Path(await _mount_from_record(record)).resolve() == real.resolve()
