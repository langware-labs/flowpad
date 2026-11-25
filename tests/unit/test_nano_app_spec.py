"""A nano-app is one ``.html`` file: its manifest and slots are read from the file, its header is text."""
import pytest

from flow_sdk.schema.data_spec.nano_app_spec import NanoAppSpec, read_nano_app, render_header

APP = """<!doctype html><html><head>
<script type="application/json" id="nano-app">{"name": "review", "title": "Review", "input": "crm.lead", "vendor": 1}</script>
</head><body>
<template data-slot="header">{{status}} ·
  {{counts.rows}} rows {{missing}}</template>
<template data-slot="block"><p>block</p></template>
<main data-slot="page"><script>1 < 2</script></main>
</body></html>"""


def test_the_file_says_what_it_is_and_which_slots_it_has():
    app = read_nano_app(APP)
    assert app == NanoAppSpec(name="review", title="Review", input="crm.lead", slots=["header", "block", "page"])


def test_an_ordinary_page_is_not_a_nano_app():
    assert read_nano_app("<html><body><main data-slot='page'>hi</main></body></html>") is None


@pytest.mark.parametrize("manifest", ["{not json", "[]", '{"title": "No name"}'])
def test_a_manifest_that_cannot_name_the_app_is_refused(manifest):
    with pytest.raises(ValueError):
        read_nano_app(f'<script type="application/json" id="nano-app">{manifest}</script>')


def test_the_header_is_one_line_of_text_filled_from_the_data():
    assert render_header(APP, {"status": "Needs <b>review</b>", "counts": {"rows": 6}}) == "Needs <b>review</b> · 6 rows"


def test_a_file_with_no_header_slot_answers_its_title():
    page = '<script type="application/json" id="nano-app">{"name": "review", "title": "Review"}</script><main>x</main>'
    assert read_nano_app(page).slots == ["page"]
    assert render_header(page, {}) == "Review"


def test_the_kind_is_registered():
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    from flow_sdk.schema.data_spec._kinds import register_builtin_kinds

    register_builtin_kinds()
    assert SchemaRegistry.kind_for(NanoAppSpec) == "nano_app"
