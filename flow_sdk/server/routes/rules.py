"""
Activation rule management routes.
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from flow_sdk.rules.engine import RuleEngine

router = APIRouter()


def _get_engine() -> RuleEngine:
    return RuleEngine()


@router.get("/api/v1/rules")
async def list_rules():
    """List all rules merged across system/user/project scopes."""
    try:
        engine = _get_engine()
        rules = engine.all_rules()
        result = []
        for r in rules:
            result.append({
                "name": r.name,
                "scope": str(r.scope) if r.scope else "user",
                "hook_events": getattr(r, 'hook_events', []) or [],
                "description": getattr(r, 'description', '') or '',
                "log_mode": getattr(r, 'log_mode', 'activations'),
                "path": str(r.record_dir) if r.record_dir else "",
            })
        return JSONResponse(content={"status": "OK", "data": result})
    except Exception as e:
        return JSONResponse(content={"status": "FAIL", "message": str(e)}, status_code=500)


@router.get("/api/v1/rules/{name}/trigger")
async def get_trigger(name: str):
    """Read trigger.py content for a rule."""
    try:
        engine = _get_engine()
        rule = engine._get_package().get(name)
        if not rule:
            return JSONResponse(content={"status": "FAIL", "message": f"Rule '{name}' not found"}, status_code=404)
        trigger_file = rule.record_dir / "trigger.py" if rule.record_dir else None
        if not trigger_file or not trigger_file.exists():
            return JSONResponse(content={"status": "FAIL", "message": "trigger.py not found"}, status_code=404)
        content = trigger_file.read_text(encoding="utf-8")
        return JSONResponse(content={"status": "OK", "data": {"content": content}})
    except Exception as e:
        return JSONResponse(content={"status": "FAIL", "message": str(e)}, status_code=500)


@router.put("/api/v1/rules/{name}/trigger")
async def save_trigger(name: str, body: dict):
    """Save trigger.py content for a rule."""
    try:
        engine = _get_engine()
        rule = engine._get_package().get(name)
        if not rule:
            return JSONResponse(content={"status": "FAIL", "message": f"Rule '{name}' not found"}, status_code=404)
        trigger_file = rule.record_dir / "trigger.py" if rule.record_dir else None
        if not trigger_file:
            return JSONResponse(content={"status": "FAIL", "message": "Rule has no record directory"}, status_code=400)
        content = body.get("content", "")
        trigger_file.write_text(content, encoding="utf-8")
        return JSONResponse(content={"status": "OK", "data": {"saved": True}})
    except Exception as e:
        return JSONResponse(content={"status": "FAIL", "message": str(e)}, status_code=500)


@router.patch("/api/v1/rules/{name}/meta")
async def update_meta(name: str, body: dict):
    """Update log_mode in record.json."""
    try:
        engine = _get_engine()
        rule = engine._get_package().get(name)
        if not rule:
            return JSONResponse(content={"status": "FAIL", "message": f"Rule '{name}' not found"}, status_code=404)
        log_mode = body.get("log_mode")
        if log_mode not in ("all", "activations"):
            return JSONResponse(content={"status": "FAIL", "message": "log_mode must be 'all' or 'activations'"}, status_code=400)
        rule.save_log_mode(log_mode)
        return JSONResponse(content={"status": "OK", "data": {"log_mode": log_mode}})
    except Exception as e:
        return JSONResponse(content={"status": "FAIL", "message": str(e)}, status_code=500)


@router.post("/api/v1/rules/{name}/test")
async def test_rule(name: str):
    """Run rule with mock UserPromptSubmit event."""
    try:
        engine = _get_engine()
        rule = engine._get_package().get(name)
        if not rule:
            return JSONResponse(content={"status": "FAIL", "message": f"Rule '{name}' not found"}, status_code=404)

        mock_data = {
            "hookEvent": "UserPromptSubmit",
            "hook_event_name": "UserPromptSubmit",
            "prompt": "",
            "cwd": "",
        }
        result = rule.run(mock_data, [])

        # Log as test entry
        try:
            from flow_sdk.fs_records.trigger_log import TriggerLogRecord
            TriggerLogRecord.append_entry(rule.name, {
                "hook_event": "UserPromptSubmit",
                "trigger": result.trigger,
                "reason": result.reason or "",
                "is_test": True,
                "rule_name": rule.name,
                "actions": [a.type for a in result.actions] if result.actions else [],
            })
        except Exception:
            pass

        return JSONResponse(content={"status": "OK", "data": result.to_dict()})
    except Exception as e:
        return JSONResponse(content={"status": "FAIL", "message": str(e)}, status_code=500)


@router.get("/api/v1/rules/{name}/log")
async def get_log(name: str, limit: int = 500, triggered_only: bool = False):
    """Return trigger log entries for a rule."""
    try:
        from flow_sdk.fs_records.trigger_log import TriggerLogRecord
        entries = TriggerLogRecord.discover(name, limit=limit)
        if triggered_only:
            entries = [e for e in entries if e.get("trigger")]
        return JSONResponse(content={"status": "OK", "data": entries})
    except Exception as e:
        return JSONResponse(content={"status": "FAIL", "message": str(e)}, status_code=500)
