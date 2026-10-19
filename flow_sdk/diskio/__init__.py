"""diskio — the disk-I/O kernel of the SDK.

Eight heavy READ pieces (tree walk, declared scan, document read, text
extraction, freshness probe, shadow store, session stats, Merkle tree hash) and
the stage-1 ``Scanner`` that composes the first two. Each is a ``Protocol`` in
:mod:`flow_sdk.diskio.contract`; :func:`flow_sdk.diskio.select.kernel` answers
the backend that implements one. The spec is ``docs/data-management/diskio.md``.

The values the pieces exchange are declared in
``flow_sdk/schema/data_spec/diskio_spec.py`` and re-exported by ``contract``.
Nothing is imported here on purpose: touching the package must not register kinds.
"""
