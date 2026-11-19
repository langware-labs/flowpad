"""Shared declared execution limits."""

STORM_CAP_PER_MINUTE = 30
#: Agent turns a conversation's process may run while no person attends it (a help desk ticket nobody picked up),
#: counted whoever wrote them -- the customer or an admin's steer. At the cap the turn does not run: the message is held
#: and a person is flagged once. A product rule, not a wait budget.
UNATTENDED_TURN_CAP = 10
