"""The registry binds entity classes on first read — no caller has to import them.

A bare SDK script (a ``FolderChanges`` loop) never imports the server or the
indexer, so nothing had imported the entity modules whose ``__init_subclass__``
attaches ``entity_cls``. ``get_entity_cls("markdown")`` came back None,
``Entity.from_record`` fell back to a bare ``Entity`` with no ``asset_ref``, and
``get_by_asset_ref`` missed the row it had just minted. A fresh interpreter is
the only honest probe: in-process, some earlier test has already imported them.
"""
import subprocess
import sys
import textwrap

_PROBE = textwrap.dedent(
    """
    import sys
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    assert "flow_sdk.fs_store.indexer.registrations" not in sys.modules, "probe is not bare"
    cls = SchemaRegistry.get_entity_cls("markdown")
    assert cls is not None, "markdown has no entity_cls in a bare process"
    assert "asset_ref" in cls.model_fields, cls

    from flow_sdk.core.entity.entity_model import Entity
    owners = Entity.asset_owner_classes()
    assert cls in owners, [c.__name__ for c in owners]
    print("OK")
    """
)


def test_bare_process_resolves_entity_classes() -> None:
    proc = subprocess.run([sys.executable, "-c", _PROBE], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr[-4000:]
    assert proc.stdout.strip().endswith("OK")
