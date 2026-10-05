"""Automations — the person-facing reading of Trigger rows (docs/automations.md).

A ``Trigger`` is the entity; an *automation* is what someone sees on the
Automations screen: a sentence ("Every weekday at 09:00 → run Chief of Staff"),
a status, its runs. Everything here is a pure library over Trigger rows and the
trigger log; the REST surface is thin actions on ``Trigger`` and the UI reaches
it only through the TS SDK.
"""
