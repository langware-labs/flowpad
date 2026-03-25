"""Unit tests for entity-record-ref submodule.

Tests that record_data_ref is no longer a field on Entity (removed per
Search-First Asset Management plan), and that the vfs/sync fields remain absent.
"""

from flow_sdk.core.entity.entity_model import Entity


class TestEntityRecordDataRefRemoved:
    def test_record_data_ref_not_a_model_field(self):
        """record_data_ref is not a declared Pydantic field on Entity."""
        assert "record_data_ref" not in Entity.model_fields

    def test_record_property_removed(self):
        """The 'record' property has been removed from Entity."""
        assert not isinstance(getattr(Entity, "record", None), property)

    def test_resolve_record_data_ref_removed(self):
        """resolve_record_data_ref method has been removed."""
        assert not hasattr(Entity, "resolve_record_data_ref")

    def test_delete_by_record_ref_removed(self):
        """delete_by_record_ref class method has been removed."""
        assert not hasattr(Entity, "delete_by_record_ref")


class TestVfsFieldsRemoved:
    def test_no_vfs_record_field(self):
        assert "vfs_record" not in Entity.model_fields

    def test_no_vfs_orphan_field(self):
        assert "vfs_orphan" not in Entity.model_fields

    def test_no_sync_record_method(self):
        assert not hasattr(Entity, "sync_record")

    def test_no_apply_record_metadata_method(self):
        assert not hasattr(Entity, "_apply_record_metadata")

    def test_no_resolve_vfs_to_local_path_method(self):
        assert not hasattr(Entity, "_resolve_vfs_to_local_path")
