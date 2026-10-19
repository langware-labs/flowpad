"""The Python backend of the disk-I/O kernel — one module per piece.

Each class adapts the SDK's existing read path to the contract; the logic
itself stays where it lives (``fs_store``, ``assets``, ``wiki``, ``llm_index``)
and is shared, not copied. ``NOTES.md`` one level up says what each shares.
"""
