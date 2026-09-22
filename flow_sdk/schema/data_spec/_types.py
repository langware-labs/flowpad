"""Small field types shared across the specs.

``NonBlank`` was defined five times, character for character, in
``compute_op_spec``, ``mcp_spec``, ``source_item_spec``, ``trigger_spec`` and
``wizard_spec``. Five copies of one constraint is five chances for one of them
to drift — and a blank name is exactly the value each of those specs exists to
refuse, so it is the same rule every time.

(``sources/values/_types.py`` keeps its own, slightly weaker one: no
``strip_whitespace``. That is a different contract, so it stays separate.)
"""

from __future__ import annotations

from typing import Annotated

from pydantic import StringConstraints

#: A name that is a HANDLE — an address segment, a ``requires`` entry, an error
#: ref. A blank one would collapse two things onto one node.
NonBlank = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]

__all__ = ["NonBlank"]
