import json

from flow_sdk.builtin.webapp_check import ERROR_LOG, ERRORS_FILE, PageError, load_rules, record, setup_dir, triage
from flow_sdk.schema.data_spec.webapp_spec import WebappErrorRule

CHIP = ("SyntaxError: The requested module '/src/components/asset-counters/AssetCounterRow.tsx?t=1' "
        "does not provide an export named 'CHIP_CLASS'")


def _write_rules(folder, rules):
    base = setup_dir(folder)
    base.mkdir(parents=True, exist_ok=True)
    (base / ERRORS_FILE).write_text(json.dumps(rules))


def test_unknown_error_is_recovered():
    verdict = triage([PageError(CHIP)], [])
    assert not verdict.usable
    assert verdict.to_recover[0].rule is None


def test_no_errors_is_usable():
    assert triage([], []).usable


def test_ignore_rule_opens_the_app():
    rule = WebappErrorRule(id="favicon", pattern=r"favicon\.ico", action="ignore", source="network")
    assert triage([PageError("404 /favicon.ico", source="network")], [rule]).usable


def test_rule_source_must_match():
    rule = WebappErrorRule(id="favicon", pattern=r"favicon", action="ignore", source="network")
    assert not triage([PageError("favicon broke", source="page")], [rule]).usable


def test_first_matching_rule_wins():
    stale = WebappErrorRule(id="stale-vite", pattern=r"does not provide an export named", fix="restart")
    anything = WebappErrorRule(id="any", pattern=r".", action="ignore")
    decision = triage([PageError(CHIP)], [stale, anything]).decisions[0]
    assert (decision.rule.id, decision.action) == ("stale-vite", "recover")


def test_bad_regex_never_matches():
    rule = WebappErrorRule(id="bad", pattern=r"(", action="ignore")
    assert not triage([PageError("x")], [rule]).usable


def test_record_logs_and_counts_seen(tmp_path):
    _write_rules(tmp_path, [{"id": "stale-vite", "pattern": "does not provide an export named", "fix": "restart"}])
    verdict = triage([PageError(CHIP), PageError("other boom")], load_rules(tmp_path))
    record(tmp_path, verdict, "recovering")
    lines = [json.loads(line) for line in (setup_dir(tmp_path) / ERROR_LOG).read_text().splitlines()]
    assert [(row["rule"], row["action"]) for row in lines] == [("stale-vite", "recover"), (None, "recover")]
    assert load_rules(tmp_path)[0].seen == 1


def test_unreadable_rules_file_reads_as_none(tmp_path):
    setup_dir(tmp_path).mkdir(parents=True)
    (setup_dir(tmp_path) / ERRORS_FILE).write_text("{not json")
    assert load_rules(tmp_path) == []
