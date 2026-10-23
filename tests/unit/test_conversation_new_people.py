"""`flow conversation new` takes one or several people in <who>."""

from flow_sdk.cli.commands.conversation_cmd import split_people


def test_one_person_stays_one():
    assert split_people("gadi@langware.ai") == ["gadi@langware.ai"]


def test_commas_and_semicolons_both_separate_people():
    assert split_people("gadi@langware.ai, Tzahi Mazuz") == ["gadi@langware.ai", "Tzahi Mazuz"]
    assert split_people("gadi@langware.ai;Tzahi Mazuz; ami@x.io") == ["gadi@langware.ai", "Tzahi Mazuz", "ami@x.io"]


def test_blanks_and_repeats_are_dropped_in_order():
    assert split_people(" a@x.io ,, ;b@x.io, a@x.io ") == ["a@x.io", "b@x.io"]
    assert split_people(" , ; ") == []
