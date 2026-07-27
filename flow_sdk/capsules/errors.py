"""Typed failures for portable asset capsules."""


class CapsuleError(Exception):
    """Base class for capsule failures."""


class InvalidCapsuleNameError(CapsuleError, ValueError):
    pass


class UnsupportedCapsuleFormatError(CapsuleError):
    pass


class MalformedCapsuleError(CapsuleError):
    pass


class DuplicateCapsuleError(MalformedCapsuleError):
    pass


class UnsupportedCapsuleVersionError(CapsuleError):
    pass


class ReadOnlyCapsuleError(CapsuleError):
    pass


class CapsuleConflictError(CapsuleError):
    pass
