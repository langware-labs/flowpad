"""A real backend whose Decision API is answered by an LLM, through the hub's own LLM endpoint.

The product's decision calls (``flow_sdk.decision``) speak Jev's wire (``POST v1/systemone``) to a hub
API endpoint marked ``decision``. A QA hub has no Jev account, so this launcher stands a decider in at the
same two seams ``tests/utils/decision_double.py`` doubles -- but instead of canned answers it asks the
instance's bound hub LLM endpoint (the funded OpenRouter public endpoint) to answer the questions, and
replies in Jev's wire shape, so the dialect's translation, the navigator's thresholds and the log all run for real.

    set -a; source .env.<name>.local; set +a
    uv run python tests/e2e/llm_decision_backend.py          # MOCK_WORKER=1: agent turns on MockDriver too
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

import httpx  # noqa: E402

from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: E402
from flow_sdk.server import run  # noqa: E402

DECIDER = {
    "id": "72575461-9352-4cdb-b2e7-a53be3e3d6e3",
    "name": "Jev (TypeSafe), answered by the hub LLM",
    "kinds": ["decision"],
    "target": {"base_url": "https://api.typesafe.ai"},
}
MODEL = os.environ.get("QA_DECISION_MODEL", "md")

SYSTEM = (
    "You are a precise decision engine. You get a STATE (JSON) and QUESTIONS. Answer every question from the "
    "state alone. Reply with ONE JSON object and nothing else: {\"<question>\": <answer>, ...} where the answer is "
    "for type 'choice': {\"choice\": \"<one key of criteria, copied exactly>\", \"confidence\": <0..1>}; "
    "for type 'score': {\"score\": <index of the best level, an integer>, \"confidence\": <0..1>}; "
    "for type 'noul': {\"p\": <probability 0..1 that the statement holds>}. "
    "Be calibrated: confidence is the probability you are right, 0.95+ only when the state leaves no doubt."
)


def _prompt(wire: dict) -> str:
    qs = {}
    for name, q in wire["questions"].items():
        qs[name] = dict(q)
    return "STATE:\n" + json.dumps(wire["state"], ensure_ascii=False) + "\n\nQUESTIONS:\n" + json.dumps(qs, ensure_ascii=False)


def _json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
    start, end = text.find("{"), text.rfind("}")
    return json.loads(text[start : end + 1])


def _wire_answers(wire: dict, raw: dict) -> dict:
    answers = {}
    for name, q in wire["questions"].items():
        got = raw.get(name) or {}
        if q["type"] == "choice":
            keys = list(q["criteria"])
            chosen = got.get("choice")
            if chosen not in keys:
                chosen = next((k for k in keys if k == "agentic"), keys[0])
                conf = 0.0
            else:
                conf = max(0.0, min(1.0, float(got.get("confidence", 0.5))))
            # Only the chosen option carries probability mass: a full distribution over ~200 options would
            # push the logged decision past the call log's 64 KB row cap and drop it from SmartNavigationLog.
            answers[name] = {"type": "choice", "choice": chosen, "confidence": conf, "probabilities": {chosen: conf}}
        elif q["type"] == "score":
            levels = list(q["criteria"])
            idx = max(0, min(len(levels) - 1, int(round(float(got.get("score", 0))))))
            conf = max(0.0, min(1.0, float(got.get("confidence", 0.5))))
            answers[name] = {
                "type": "score",
                "score": float(idx),
                "confidence": conf,
                "legend": {str(i): lvl for i, lvl in enumerate(levels)},
                "probabilities": {str(idx): conf},
            }
        else:
            answers[name] = {"type": "noul", "noul": max(0.0, min(1.0, float(got.get("p", 0.5))))}
    return answers


def main() -> None:
    real_send = HubProxy.send
    real_call, real_try_call = HubProxy.call, HubProxy.try_call

    def _doubled(real):
        async def _hub_call(method, entity_type, *args, **kwargs):
            if entity_type != "api_endpoint":
                return await real(method, entity_type, *args, **kwargs)
            action = kwargs.get("action", args[1] if len(args) > 1 else None)
            return [DECIDER] if action == "catalog" else {"data": []}

        return _hub_call

    async def _send(method, url, *, json=None, **kwargs):  # noqa: A002
        if "/api_endpoint/" not in str(url):
            return await real_send(method, url, json=json, **kwargs)
        from flow_sdk.instance_settings.llm_endpoint import get_hub_llm_endpoint  # noqa: PLC0415

        bound = get_hub_llm_endpoint()
        llm_url = f"{bound.hub_origin.rstrip('/')}{bound.invoke_path}/v1/chat/completions"
        body = {
            "model": MODEL,
            "temperature": 0,
            "max_tokens": 600,
            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": _prompt(json)}],
        }
        resp = await real_send("POST", llm_url, json=body)
        if resp.status_code != 200:
            return httpx.Response(resp.status_code, json={"error": "llm", "message": resp.text[:300]})
        try:
            text = resp.json()["choices"][0]["message"]["content"]
            answers = _wire_answers(json, _json(text))
        except Exception as exc:  # noqa: BLE001
            return httpx.Response(502, json={"error": "bad_llm_answer", "message": f"{type(exc).__name__}: {exc}"})
        return httpx.Response(
            200, json={"model": "jev-via-hub-llm", "answers": answers, "usage": {"input_tokens": 0, "output_tokens": 0}}
        )

    HubProxy.call = staticmethod(_doubled(real_call))
    HubProxy.try_call = staticmethod(_doubled(real_try_call))
    HubProxy.send = staticmethod(_send)
    print("[llm-decision] the Decision API answers from the hub LLM endpoint", flush=True)
    if os.environ.get("MOCK_WORKER"):
        import tempfile  # noqa: PLC0415

        import flow_sdk.builtin.agentic_process.agentic_process as agentic_process  # noqa: PLC0415
        from tests.utils.mock_worker import MockDriver  # noqa: PLC0415

        driver = MockDriver(Path(os.environ.get("MOCK_TRANSCRIPTS") or tempfile.mkdtemp(prefix="flowpad-mock-worker-")))
        agentic_process.get_driver = lambda _worker_type: driver
        print("[mock-worker] agent turns answer from MockDriver", flush=True)
    run.main()


if __name__ == "__main__":
    main()
