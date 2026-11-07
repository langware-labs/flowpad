"""A placement made BY a message answers from that message: it is an arrival, not history.

A private deployment's person machine is placed on that person's first mail, so the mail is older than the
machine. Without ``answers_from`` the loop skips it as backlog and the person is never answered.
"""

from datetime import datetime, timezone
from types import SimpleNamespace

from flow_sdk.builtin.agent_serve import bound_at, is_history

MACHINE_MADE = "2026-11-07T14:28:49Z"
MAIL_SENT = "2026-11-07T14:28:21Z"


def _mail(at: str):
    return SimpleNamespace(_row=SimpleNamespace(occurred_at=at))


def test_a_message_older_than_the_machine_is_history_without_answers_from():
    deployment = SimpleNamespace(created_date=MACHINE_MADE, answers_from=None)
    source = SimpleNamespace(created_date=MACHINE_MADE)
    assert is_history(_mail(MAIL_SENT), bound_at(deployment, source))


def test_the_message_that_placed_the_machine_is_an_arrival():
    deployment = SimpleNamespace(created_date=MACHINE_MADE, answers_from=MAIL_SENT)
    source = SimpleNamespace(created_date=MACHINE_MADE)
    since = bound_at(deployment, source)
    assert since == datetime(2026, 11, 7, 14, 28, 21, tzinfo=timezone.utc)
    assert not is_history(_mail(MAIL_SENT), since)
    assert is_history(_mail("2026-11-07T14:00:00Z"), since), "older mail stays history"
