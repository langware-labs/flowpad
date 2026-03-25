"""Template engine error types."""


class TemplateError(Exception):
    """Base error for template engine operations."""


class CircularDependencyError(TemplateError):
    """Raised when templates have circular dependencies."""


class DuplicateTemplateError(TemplateError):
    """Raised when a template name is registered more than once."""
