"""Python 3.10 compatibility shims."""
import sys

if sys.version_info >= (3, 11):
    from enum import StrEnum
    from typing import Self, NotRequired, Unpack
else:
    from enum import Enum

    class StrEnum(str, Enum):
        def __str__(self) -> str:
            return self.value

        def __format__(self, format_spec: str) -> str:
            return self.value.__format__(format_spec)

    from typing_extensions import Self, NotRequired, Unpack

import sys as _sys

if _sys.version_info >= (3, 11):
    from datetime import UTC
else:
    from datetime import timezone as _tz
    UTC = _tz.utc

__all__ = ["StrEnum", "Self", "NotRequired", "Unpack", "UTC"]
