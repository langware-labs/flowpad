"""One eval run as a self-contained HTML report: headline numbers, slices, every example.

No build step and no network: the run and its examples are embedded as JSON and a few lines of
script render and filter them. Click a slice value (or a verdict) to filter the examples; failures
come first; each example expands to its gold, prediction and labels.
"""

from __future__ import annotations

import html
import json
from typing import Any

from flow_sdk.schema.data_spec.eval_spec import EvalRun, EvalSpec, ExampleEval

_STYLE = """
:root{--bg:#fbfbfa;--card:#fff;--fg:#1d1d1f;--muted:#6b6b70;--line:#e6e6e3;--accent:#4b4fd6;
--correct:#2f9e6a;--wrong:#d4553c;--abstained:#c99a2e;--error:#8a5cd1;--chip:#f1f1ee}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--card:#1a1a1d;--fg:#ececee;--muted:#9a9aa2;
--line:#2a2a2f;--accent:#8b8ef0;--chip:#232328}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,
BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}main{max-width:1180px;margin:0 auto;padding:28px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 10px;letter-spacing:.02em}
.muted{color:var(--muted)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.card b{display:block;font-size:24px;font-variant-numeric:tabular-nums}.card span{color:var(--muted);font-size:12px}
.bar{display:flex;height:12px;border-radius:6px;overflow:hidden;margin:16px 0 6px;background:var(--line)}
.bar div{cursor:pointer}.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted)}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:middle}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600;background:var(--chip)}td.n{font-variant-numeric:tabular-nums}
tr.sv{cursor:pointer}tr.sv:hover td{background:var(--chip)}tr.on td{background:color-mix(in srgb,var(--accent) 12%,transparent)}
.slices{display:grid;grid-template-columns:1fr;gap:14px}.scroll{overflow-x:auto;border-radius:12px}
.mini{display:flex;height:6px;border-radius:3px;overflow:hidden;min-width:90px;background:var(--line)}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
input,select{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 9px;font:inherit}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;color:#fff}
.chip{display:inline-block;padding:1px 7px;border-radius:6px;background:var(--chip);font-size:12px;margin:1px 3px 1px 0}
tr.ex{cursor:pointer}tr.detail td{background:var(--chip)}pre{margin:0;white-space:pre-wrap;word-break:break-word}
.active-filter{color:var(--accent);font-size:12px}button{background:none;border:1px solid var(--line);
border-radius:8px;padding:5px 10px;color:var(--fg);cursor:pointer;font:inherit}
@media (max-width:640px){th:nth-child(4),td:nth-child(4){display:none}}
"""

_SCRIPT = r"""
const RUN = JSON.parse(document.getElementById('run').textContent);
const EX = JSON.parse(document.getElementById('examples').textContent);
const ORDER = {error:0, wrong:1, abstained:2, correct:3};
const COLOR = v => `var(--${v})`;
const state = {verdict:'', slice:null, q:'', label:''};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
// Which metrics are counts: decided once, in Python, from the values' type (int vs float).
const COUNTS = new Set(JSON.parse(document.getElementById('counts').textContent));
const COUNT = k => COUNTS.has(k);
const fmt = (v, k) => v == null ? '—' : typeof v !== 'number' ? esc(v)
  : COUNT(k) ? String(Math.round(v)) : v >= 0 && v <= 1 ? `${(v*100).toFixed(1)}%` : v.toFixed(2);
const brief = v => v == null ? '—' : typeof v === 'object'
  ? (v.route ? (v.target ? `${v.route} → ${v.target.kind}:${v.target.value}` : v.route) : JSON.stringify(v)) : String(v);
function bar(counts, el, total){
  el.innerHTML = ['correct','abstained','wrong','error'].filter(v => counts[v]).map(v =>
    `<div title="${v}: ${counts[v]}" data-v="${v}" style="width:${100*counts[v]/total}%;background:${COLOR(v)}"></div>`).join('');
}
function renderSlices(){
  const root = document.getElementById('slices'); root.innerHTML = '';
  for (const [path, values] of Object.entries(RUN.slices)) {
    const rows = Object.entries(values).sort((a,b) => b[1].examples - a[1].examples);
    const metricKeys = [...new Set(rows.flatMap(([,m]) => Object.keys(m)))].filter(k =>
      !['examples','correct','wrong','abstained','error'].includes(k));
    root.insertAdjacentHTML('beforeend', `<div class="scroll"><table><thead><tr><th>${esc(path)}</th><th>n</th><th>verdicts</th>
      ${metricKeys.map(k => `<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>${rows.map(([val,m]) => {
        const on = state.slice && state.slice[0]===path && state.slice[1]===val;
        return `<tr class="sv ${on?'on':''}" data-p="${esc(path)}" data-v="${esc(val)}"><td>${esc(val)}</td>
        <td class="n">${m.examples}</td><td><div class="mini">${['correct','abstained','wrong','error'].filter(v=>m[v]).map(v =>
        `<div style="width:${100*m[v]/m.examples}%;background:${COLOR(v)}"></div>`).join('')}</div></td>
        ${metricKeys.map(k => `<td class="n">${fmt(m[k], k)}</td>`).join('')}</tr>`}).join('')}</tbody></table></div>`);
  }
  root.querySelectorAll('tr.sv').forEach(tr => tr.onclick = () => {
    const key = [tr.dataset.p, tr.dataset.v];
    state.slice = state.slice && state.slice[0]===key[0] && state.slice[1]===key[1] ? null : key;
    renderSlices(); renderExamples();
  });
}
function renderExamples(){
  const q = state.q.toLowerCase();
  const rows = EX.filter(e => (!state.verdict || e.verdict === state.verdict)
    && (!state.slice || e.slice[state.slice[0]] === state.slice[1])
    && (!state.label || Object.entries(e.labels).some(([k,v]) => `${k}=${v}` === state.label))
    && (!q || JSON.stringify(e).toLowerCase().includes(q)))
    .sort((a,b) => ORDER[a.verdict]-ORDER[b.verdict] || (a.title > b.title ? 1 : -1));
  document.getElementById('shown').textContent = `${rows.length} of ${EX.length}`;
  document.getElementById('active').textContent = state.slice ? `filtered by ${state.slice[0]} = ${state.slice[1]}` : '';
  document.getElementById('ex').innerHTML = rows.map((e,i) => `<tr class="ex" data-i="${i}">
    <td><span class="pill" style="background:${COLOR(e.verdict)}">${e.verdict}</span></td>
    <td>${esc(e.title)}</td><td class="mono">${esc(brief(e.golds.length>1 ? e.golds.map(brief).join(' | ') : e.golds[0]))}</td>
    <td class="mono">${esc(brief(e.prediction))}</td><td class="n">${e.score==null?'—':Number(e.score).toFixed(2)}</td>
    <td>${Object.entries(e.labels).map(([k,v]) => `<span class="chip">${esc(k)}=${esc(v)}</span>`).join('')}</td></tr>
    <tr class="detail" hidden><td colspan="6"><pre class="mono">${esc(JSON.stringify({example_id:e.example_id, slice:e.slice,
      golds:e.golds, prediction:e.prediction, labels:e.labels, latency_ms:e.latency_ms, error:e.error}, null, 2))}</pre></td></tr>`).join('');
  document.querySelectorAll('tr.ex').forEach(tr => tr.onclick = () => { tr.nextElementSibling.hidden = !tr.nextElementSibling.hidden; });
}
const total = Math.max(1, RUN.examples);
bar(RUN.counts, document.getElementById('bar'), total);
document.querySelectorAll('#bar div').forEach(d => d.onclick = () => {
  state.verdict = state.verdict === d.dataset.v ? '' : d.dataset.v; document.getElementById('verdict').value = state.verdict; renderExamples(); });
const labels = [...new Set(EX.flatMap(e => Object.entries(e.labels).map(([k,v]) => `${k}=${v}`)))].sort();
document.getElementById('label').innerHTML = '<option value="">any label</option>' + labels.map(l => `<option>${esc(l)}</option>`).join('');
document.getElementById('verdict').onchange = e => { state.verdict = e.target.value; renderExamples(); };
document.getElementById('label').onchange = e => { state.label = e.target.value; renderExamples(); };
document.getElementById('q').oninput = e => { state.q = e.target.value; renderExamples(); };
document.getElementById('clear').onclick = () => { Object.assign(state, {verdict:'', slice:null, q:'', label:''});
  ['verdict','label','q'].forEach(id => document.getElementById(id).value = ''); renderSlices(); renderExamples(); };
renderSlices(); renderExamples();
"""


def _card(value: Any, label: str) -> str:
    """A count is an int, a ratio a float (``EvalRun.metrics``) -- the type decides how it reads."""
    if value is None:
        shown = "—"
    elif isinstance(value, int) and not isinstance(value, bool):
        shown = str(value)
    elif isinstance(value, float) and 0 <= value <= 1:
        shown = f"{value:.1%}"
    else:
        shown = value
    return f'<div class="card"><b>{html.escape(str(shown))}</b><span>{html.escape(label)}</span></div>'


def render(run: EvalRun, examples: list[ExampleEval], spec: EvalSpec) -> str:
    """The report page for one run."""
    metrics = run.metrics
    order = ["accuracy", *[m for m in spec.metrics if m != "accuracy"]]
    keys = [k for k in order if k in metrics] + [k for k in metrics if k not in order]
    cards = [_card(run.examples, "examples")] + [_card(metrics[k], k.replace("_", " ")) for k in keys]
    versions = " · ".join(f"{k} {v}" for k, v in run.versions.items())
    legend = "".join(
        f'<span><i class="dot" style="background:var(--{v})"></i>{v} {run.counts.get(v, 0)}</span>'
        for v in ("correct", "abstained", "wrong", "error")
    )

    def blob(tag: str, value: Any) -> str:
        data = json.dumps(value).replace("</", "<\\/")  # never close the script tag from inside the data
        return f'<script type="application/json" id="{tag}">{data}</script>'

    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Eval · {html.escape(run.dataset_title)}</title>
<style>{_STYLE}</style></head><body><main>
<h1>{html.escape(run.dataset_title)} <span class="muted">· {html.escape(run.eval_name)}</span></h1>
<div class="muted">{html.escape(run.dataset_spec)} · run {html.escape(run.run_id)} · eval {html.escape(run.eval_digest)}
{(" · " + html.escape(versions)) if versions else ""}</div>
<div class="muted">{html.escape(spec.description)}</div>
<div class="cards">{"".join(cards)}</div>
<div class="bar" id="bar"></div><div class="legend">{legend}</div>
<h2>Slices <span class="muted">— click a value to filter the examples</span></h2><div class="slices" id="slices"></div>
<h2>Examples <span class="muted" id="shown"></span> <span class="active-filter" id="active"></span></h2>
<div class="filters"><select id="verdict"><option value="">any verdict</option><option>correct</option>
<option>abstained</option><option>wrong</option><option>error</option></select><select id="label"></select>
<input id="q" placeholder="search…"><button id="clear">clear filters</button></div>
<table><thead><tr><th>verdict</th><th>input</th><th>gold</th><th>prediction</th><th>score</th><th>labels</th></tr></thead>
<tbody id="ex"></tbody></table>
{blob("counts", run.count_metrics())}{blob("run", run.model_dump(mode="json"))}{blob("examples", [e.model_dump(mode="json") for e in examples])}
<script>{_SCRIPT}</script></main></body></html>
"""


__all__ = ["render"]
