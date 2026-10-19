"""Field types shared by the source values."""

from __future__ import annotations

from typing import Annotated

from pydantic import StringConstraints

#: An identity component. The SDK preserves input strings exactly — no trimming, no
#: normalization — so blankness is the one thing refused: an empty ``kind``, ``namespace``
#: or ``key`` would collapse every resource of a scope onto one identity.
NonBlank = Annotated[str, StringConstraints(min_length=1)]
