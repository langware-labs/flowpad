"""PropertyRecord — backward-compatibility alias for RecordField.

RecordField is the canonical class. PropertyRecord is preserved so that existing
subclasses (SessionActivePropertyRecord, _SessionStatsProp, etc.) continue to
work without changes.
"""

from .record_field import RecordField

PropertyRecord = RecordField
