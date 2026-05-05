"""Cross-channel notification primitives.

The single source of truth for what gets sent over WebSocket and what gets
emailed: ``NotificationEnvelope``. WS payload + email payload are projections
of the same struct so they cannot drift.
"""

from flow_sdk.notifications.envelope import NotificationEnvelope as NotificationEnvelope
