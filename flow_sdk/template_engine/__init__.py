"""Lightweight template engine using Handlebars (.md files) with dependency resolution."""

from .engine import TemplateEngine
from .errors import CircularDependencyError, DuplicateTemplateError, TemplateError

__all__ = [
    "TemplateEngine",
    "TemplateError",
    "CircularDependencyError",
    "DuplicateTemplateError",
]
