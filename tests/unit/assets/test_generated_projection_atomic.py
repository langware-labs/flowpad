from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.assets.directory import AssetDir
from flow_sdk.assets.process_projection import EmbeddedAsset, materialize_projection, owns_projection
from flow_sdk.fs_store.type_id import TypeId


@pytest.mark.parametrize("content", ["new content", b"new content"])
def test_failed_generated_write_preserves_owned_projection_and_receipt(tmp_path, monkeypatch, content):
    ref = TypeId(type="subagent", id=mint_uuid())
    path = tmp_path / "probe.md"
    receipt = materialize_projection(EmbeddedAsset(name="probe", path=path, content="original"), ref=ref, receipts={})
    receipts = {str(ref): receipt}

    def failed_write(*args, **kwargs):
        raise OSError("generated content write failed")

    monkeypatch.setattr(Path, "write_bytes" if isinstance(content, bytes) else "write_text", failed_write)
    with pytest.raises(OSError, match="generated content write failed"):
        if isinstance(content, bytes):
            AssetDir(tmp_path).load_asset("probe.md", content=content)
        else:
            materialize_projection(EmbeddedAsset(name="probe", path=path, content=content), ref=ref, receipts=receipts)
    assert path.read_text() == "original"
    assert owns_projection(receipt)
    assert receipts == {str(ref): receipt}
    assert sorted(p.name for p in tmp_path.iterdir()) == ["probe.md"]
