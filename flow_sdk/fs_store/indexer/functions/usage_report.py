"""Extractor for USAGE_REPORT records.

Usage reports live at ``<scope>/agentic-assets/usage_report/<name>/report.json`` — one
folder per generated report. The serializer reads the headline metrics out of
the document's ``data`` section (``UsageReportSpec``); the payload itself is
deliberately excluded from FTS and from the record.
"""
from __future__ import annotations
