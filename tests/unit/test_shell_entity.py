"""Unit tests for Shell entity lifecycle."""

import uuid

import pytest

from flow_sdk.builtin.shell import Shell
from flow_sdk.fs_records.shell_record import ShellRecord, ShellStatus
from flow_sdk.fs_store.record import get_default_records_root, set_default_records_root


@pytest.fixture(autouse=True)
def use_tmp_records_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


@pytest.mark.asyncio
async def test_from_record():
    """Create ShellRecord, call Shell.from_record(), verify field mapping."""
    record = ShellRecord(
        id=str(uuid.uuid4()),
        workdir="/home/user",
        name="Terminal 1",
        state=ShellStatus.RUNNING,
        tab_order=1,
    )
    record.save()

    shell = await Shell.from_record(record)
    assert shell.id == record.id
    assert shell.workdir == "/home/user"
    assert shell.tab_order == 1
    assert shell.status == ShellStatus.RUNNING.value


@pytest.mark.asyncio
async def test_sync_from_record():
    """Modify record, sync to entity, verify update."""
    record = ShellRecord(
        id=str(uuid.uuid4()),
        workdir="/old/path",
        state=ShellStatus.RUNNING,
        tab_order=0,
    )
    record.save()

    shell = await Shell.from_record(record)
    assert shell.workdir == "/old/path"

    # Modify record
    record.workdir = "/new/path"
    record.tab_order = 3
    record.save()

    shell.sync_from_record(record)
    await shell.save()

    retrieved = await Shell.get_one({"id": shell.id})
    assert retrieved.workdir == "/new/path"
    assert retrieved.tab_order == 3


@pytest.mark.asyncio
async def test_close():
    """Call close(), verify entity is removed from DB (close deletes the entity)."""
    shell = Shell(id=str(uuid.uuid4()), status=ShellStatus.RUNNING.value)
    await shell.save()

    await shell.close()

    retrieved = await Shell.get_one({"id": shell.id})
    assert retrieved is None


@pytest.mark.asyncio
async def test_get_active_sessions():
    """RUNNING shells are active; CLOSED shells are not."""
    running1 = Shell(id=str(uuid.uuid4()), status=ShellStatus.RUNNING.value, tab_order=2)
    await running1.save()

    running2 = Shell(id=str(uuid.uuid4()), status=ShellStatus.RUNNING.value, tab_order=1)
    await running2.save()

    closed = Shell(id=str(uuid.uuid4()), status=ShellStatus.CLOSED.value, tab_order=0)
    await closed.save()

    active = await Shell.get_active_sessions()
    active_ids = [s.id for s in active]

    assert running1.id in active_ids
    assert running2.id in active_ids
    assert closed.id not in active_ids

    # Verify order by tab_order
    assert active[0].tab_order <= active[1].tab_order
