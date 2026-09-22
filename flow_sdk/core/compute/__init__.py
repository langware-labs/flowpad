"""Execution machinery shared by every caller in the compute system.

None of it is wizard-shaped, and all of it was living under ``core/wizard/``
only because the Wizard was the first caller: a shell runner that never raises,
an agent launcher that awaits a spawned harness, and the receipt an agent writes
to return a typed value. A ComputeOp needs all three, and importing them from
the Wizard was the last thing tying the two together.

No re-exports: every caller imports from the submodule that owns the symbol
(``core.compute.exec``, ``.process_step``, ``.receipt``), which is what keeps
the receipt's stdlib-only import cost off a caller that only wants a shell.
"""
