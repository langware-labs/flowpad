"""TEMPORARY: a deliberately failing test to exercise the PyPI deploy Test gate.

This forces the `PR Tests` workflow red so we can verify the deploy skill blocks
publishing and sends the Slack DM. DELETE this file once the gate is verified.
"""


def test_ci_gate_is_red_on_purpose():
    assert False, "intentional failure to test the PyPI deploy gate; delete this file"
