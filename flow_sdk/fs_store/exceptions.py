"""Custom exceptions for fs_store."""


class ReadOnlyRecordError(Exception):
    """Raised when attempting to write a read-only record."""


class ReadOnlyProviderError(Exception):
    """Raised when attempting to write via a read-only provider."""
