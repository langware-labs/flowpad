"""Logging utilities for flow_sdk."""

import logging

_logger = logging.getLogger("flow_sdk.skill")


def skill_log(message: str) -> None:
    """Log a message from the MCP skill layer.

    Uses standard logging so output is controlled by the caller's
    logging configuration.  Falls back to DEBUG level so logs are
    quiet unless explicitly enabled.
    """
    _logger.debug(message)
