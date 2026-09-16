"""``WizardCheckSpec.outcome_for`` — the exit code → step outcome table.

Pure: no subprocess, no event loop. The timeout POLICY is asserted here
(``timed_out`` resolves to EXECUTE) rather than by a test that actually waits
for one, which would be a wall-clock test pretending to be a unit test.
"""
from __future__ import annotations

import pytest

from flow_sdk.schema.data_spec.wizard_spec import CheckOutcome, WizardCheckSpec

pytestmark = pytest.mark.timeout(5)

CHECK = WizardCheckSpec(commands={"linux": "command -v python3"})


@pytest.mark.parametrize(
    "returncode,expected",
    [
        (0, CheckOutcome.SATISFIED),
        (1, CheckOutcome.EXECUTE),
        # 127 is "command not found" — the single most common way a check fails
        # on the bare machine a wizard exists to fix.
        (127, CheckOutcome.EXECUTE),
        (255, CheckOutcome.EXECUTE),
    ],
)
def test_default_map_needs_no_configuration(returncode, expected):
    assert CHECK.outcome_for(returncode) is expected


def test_a_timeout_is_execute_not_satisfied():
    """An unanswered question is not a satisfied one. Running an idempotent
    installer we did not need costs far less than skipping one we did."""
    assert CHECK.outcome_for(None, timed_out=True) is CheckOutcome.EXECUTE
    assert CHECK.outcome_for(0, timed_out=True) is CheckOutcome.EXECUTE


def test_a_command_that_never_ran_is_execute():
    assert CHECK.outcome_for(None) is CheckOutcome.EXECUTE


def test_custom_satisfied_codes():
    check = WizardCheckSpec(commands={"linux": "x"}, satisfied_codes=[0, 3])
    assert check.outcome_for(3) is CheckOutcome.SATISFIED
    assert check.outcome_for(1) is CheckOutcome.EXECUTE


def test_not_applicable_codes_are_opt_in():
    """Empty by default, so nothing is ever silently skipped unless asked for."""
    assert CHECK.not_applicable_codes == []
    check = WizardCheckSpec(commands={"linux": "x"}, not_applicable_codes=[42])
    assert check.outcome_for(42) is CheckOutcome.NOT_APPLICABLE


def test_no_command_for_this_platform_is_silent_not_failing():
    assert CHECK.command_for("win32") is None
    assert CHECK.command_for("linux") == "command -v python3"
