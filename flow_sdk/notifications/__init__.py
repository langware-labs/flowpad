"""Notification services — the imperative server→client UI-directive channel.

The single home for the ``ui_command`` envelope and the desktop-notification
service: tell a connected window to navigate, open a file, or show a desktop
notification. Domain code (actions, the hub bridge) depends on THIS package to
emit UI directives; it never reaches into ``server/routes`` to build a frame
itself.
"""

from flow_sdk.notifications.desktop import (
    build_desktop_payload as build_desktop_payload,
)
from flow_sdk.notifications.desktop import (
    notify_desktop as notify_desktop,
)
from flow_sdk.notifications.desktop import (
    notify_desktop_raw as notify_desktop_raw,
)
from flow_sdk.notifications.ui_command import (
    broadcast_ui_command as broadcast_ui_command,
)
from flow_sdk.notifications.ui_command import (
    build_ui_command as build_ui_command,
)
from flow_sdk.notifications.ui_command import (
    send_ui_command as send_ui_command,
)
