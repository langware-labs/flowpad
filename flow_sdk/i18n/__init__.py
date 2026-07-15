"""Backend i18n — the single source of truth for which locales the app ships."""

from flow_sdk.i18n.supported_locales import SUPPORTED_LOCALES, get_supported_locales
from flow_sdk.i18n.translation_targets import (
    TRANSLATION_TARGETS,
    get_translation_target,
    get_translation_targets,
)

__all__ = [
    "SUPPORTED_LOCALES",
    "get_supported_locales",
    "TRANSLATION_TARGETS",
    "get_translation_target",
    "get_translation_targets",
]
