"""Custom exceptions for fs_store."""


class ReadOnlyRecordError(Exception):
    """Raised when attempting to write a read-only record."""


class ReadOnlyProviderError(Exception):
    """Raised when attempting to write via a read-only provider."""


class AssetRefLookupError(Exception):
    """An ``asset_ref`` owner lookup could not be COMPLETED.

    Distinct from "no owner": a contended writer makes every candidate type
    answer "not mine", and a caller that MINTS or DELETES on a miss would then
    act on an answer nobody actually gave. Raised only in ``strict`` mode, which
    every write-on-miss caller passes.
    """
