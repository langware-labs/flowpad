"""Unit tests for FileSodStorage's sync API.

Covers the construction-via-(key, file_path) path added in Phase A of the
InstanceSettings consolidation. The legacy cfg-based async path is exercised
by tests/unit/test_sod.py and is not re-tested here.
"""

from __future__ import annotations

import os
import stat
import threading
import time
from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from flow_sdk.sod.file_sod import FileSodStorage


@pytest.fixture
def sod(tmp_path: Path) -> FileSodStorage:
    return FileSodStorage(key=Fernet.generate_key(), file_path=tmp_path / "sodot")


def test_round_trip(sod: FileSodStorage) -> None:
    sod.write("api_key", "secret-value")
    assert sod.read("api_key") == "secret-value"


def test_read_missing_returns_none_no_file(tmp_path: Path) -> None:
    sod = FileSodStorage(key=Fernet.generate_key(), file_path=tmp_path / "sodot")
    assert sod.read("nothing") is None
    assert not (tmp_path / "sodot").exists()


def test_read_missing_key_returns_none(sod: FileSodStorage) -> None:
    sod.write("a", "1")
    assert sod.read("b") is None


def test_overwrite(sod: FileSodStorage) -> None:
    sod.write("k", "v1")
    sod.write("k", "v2")
    assert sod.read("k") == "v2"


def test_delete(sod: FileSodStorage) -> None:
    sod.write("k", "v")
    sod.delete("k")
    assert sod.read("k") is None


def test_delete_missing_is_noop(sod: FileSodStorage) -> None:
    sod.delete("never-existed")  # must not raise


def test_delete_no_file_is_noop(tmp_path: Path) -> None:
    sod = FileSodStorage(key=Fernet.generate_key(), file_path=tmp_path / "sodot")
    sod.delete("anything")  # file doesn't exist; must not raise


def test_list(sod: FileSodStorage) -> None:
    assert sod.list() == []
    sod.write("a", "1")
    sod.write("b", "2")
    assert sorted(sod.list()) == ["a", "b"]


def test_exists(sod: FileSodStorage) -> None:
    assert sod.exists("k") is False
    sod.write("k", "v")
    assert sod.exists("k") is True
    sod.delete("k")
    assert sod.exists("k") is False


def test_file_permissions_0600_after_write(tmp_path: Path) -> None:
    file_path = tmp_path / "sodot"
    sod = FileSodStorage(key=Fernet.generate_key(), file_path=file_path)
    sod.write("k", "v")
    mode = stat.S_IMODE(os.stat(file_path).st_mode)
    assert mode == 0o600, f"expected 0o600, got {oct(mode)}"


def test_data_is_actually_encrypted(tmp_path: Path) -> None:
    """Bytes on disk must not contain plaintext value."""
    file_path = tmp_path / "sodot"
    sod = FileSodStorage(key=Fernet.generate_key(), file_path=file_path)
    sod.write("secret_name", "PLAINTEXT_NEVER_ON_DISK")
    raw = file_path.read_bytes()
    assert b"PLAINTEXT_NEVER_ON_DISK" not in raw
    assert b"secret_name" not in raw


def test_lock_file_sibling_path(tmp_path: Path) -> None:
    """Lock path lives next to the sodot file (not nested)."""
    sod = FileSodStorage(key=Fernet.generate_key(), file_path=tmp_path / "sodot")
    assert Path(sod.lock_path).parent == tmp_path
    assert Path(sod.lock_path).name == "sodot.lock"


def test_two_instances_share_data(tmp_path: Path) -> None:
    """Two FileSodStorage instances using the same key + file see the same data."""
    key = Fernet.generate_key()
    file_path = tmp_path / "sodot"
    sod_a = FileSodStorage(key=key, file_path=file_path)
    sod_b = FileSodStorage(key=key, file_path=file_path)
    sod_a.write("k", "from_a")
    assert sod_b.read("k") == "from_a"


def test_different_keys_cannot_read(tmp_path: Path) -> None:
    """A FileSodStorage with the wrong key cannot decrypt data written by another."""
    file_path = tmp_path / "sodot"
    sod_a = FileSodStorage(key=Fernet.generate_key(), file_path=file_path)
    sod_b = FileSodStorage(key=Fernet.generate_key(), file_path=file_path)
    sod_a.write("k", "v")
    with pytest.raises(Exception):  # InvalidToken or similar from Fernet
        sod_b.read("k")


def test_concurrent_writes_serialize(tmp_path: Path) -> None:
    """Writes from two threads against the same file all succeed and the
    final state contains every written key (FileLock serializes the
    read-modify-write cycle)."""
    key = Fernet.generate_key()
    file_path = tmp_path / "sodot"

    def writer(prefix: str, n: int) -> None:
        sod = FileSodStorage(key=key, file_path=file_path)
        for i in range(n):
            sod.write(f"{prefix}-{i}", str(i))

    threads = [
        threading.Thread(target=writer, args=("a", 20)),
        threading.Thread(target=writer, args=("b", 20)),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    sod = FileSodStorage(key=key, file_path=file_path)
    keys = sod.list()
    a_keys = [k for k in keys if k.startswith("a-")]
    b_keys = [k for k in keys if k.startswith("b-")]
    assert len(a_keys) == 20, f"lost some 'a' writes: {a_keys}"
    assert len(b_keys) == 20, f"lost some 'b' writes: {b_keys}"


def test_constructor_accepts_str_key(tmp_path: Path) -> None:
    """Fernet keys are commonly passed as base64-encoded str; the constructor
    should accept either bytes or str."""
    key_bytes = Fernet.generate_key()
    key_str = key_bytes.decode()
    sod = FileSodStorage(key=key_str, file_path=tmp_path / "sodot")
    sod.write("k", "v")
    assert sod.read("k") == "v"


def test_constructor_accepts_path_object(tmp_path: Path) -> None:
    """file_path may be a Path; tested implicitly elsewhere but pin it here."""
    sod = FileSodStorage(key=Fernet.generate_key(), file_path=tmp_path / "sub" / "sodot")
    # parent doesn't exist yet — write should create it via save_file's mkdir.
    sod.write("k", "v")
    assert (tmp_path / "sub" / "sodot").exists()
    assert sod.read("k") == "v"
