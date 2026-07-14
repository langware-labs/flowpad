"""App actions module."""

# Import CRUD actions to register them — side-effect imports, not re-exports.
from . import (  # noqa: F401
    address_book_action,
    context_resolve_action,
    context_share_action,
    diagnose_action,
    execute_prompt,
    flow_message_action,
    graph_crud_actions,
    group_task_action,
    members_action,
    message_attachment_action,
    notification_action,
    prompt_pin_action,
    report_action,
    share_action,
    task_receive_action,
    wiki_action,
)
