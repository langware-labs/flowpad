/**
 * Custom Playwright reporter: report.json + a self-contained report.html, written OUTSIDE the
 * repo to ${WL_REPORT_DIR:-~/Downloads/webapp-lifecycle/<stamp>}. Writes `tiers-1-2.pass` there
 * when every tier-1 and tier-2 test ran and passed (tier 3 is gated on it).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { reportDir } from './_reportdir';

interface Row {
  file: string;
  title: string;
  status: string;
  expected: string;
  durationMs: number;
  error?: string;
  metrics?: Record<string, unknown>;
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export default class WlReporter implements Reporter {
  private rows: Row[] = [];
  private dir = reportDir();

  onTestEnd(test: TestCase, result: TestResult): void {
    const att = result.attachments.filter((a) => a.name === 'wl-metrics' && a.body);
    const metrics = att.length ? Object.assign({}, ...att.map((a) => JSON.parse(a.body!.toString()))) : undefined;
    this.rows.push({
      file: test.location.file.split('/').pop() || '',
      title: test.titlePath().slice(2).join(' › '),
      status: result.status,
      expected: test.expectedStatus,
      durationMs: result.duration,
      error: result.error?.message?.split('\n').slice(0, 6).join('\n'),
      metrics,
    });
  }

  onEnd(result: FullResult): void {
    mkdirSync(this.dir, { recursive: true });
    const doc = {
      instance: process.env.WL_INSTANCE || '',
      finished: new Date().toISOString(),
      overall: result.status,
      tests: this.rows,
    };
    writeFileSync(`${this.dir}/report.json`, JSON.stringify(doc, null, 2));
    writeFileSync(`${this.dir}/report.html`, html(doc));
    const t12 = this.rows.filter((r) => /tier[12]_/.test(r.file));
    if (t12.length && t12.every((r) => r.status === 'passed')) writeFileSync(`${this.dir}/tiers-1-2.pass`, doc.finished);
    console.log(`\nwebapp-lifecycle report: ${this.dir}/report.html`);
  }
}

function html(doc: { instance: string; finished: string; overall: string; tests: Row[] }): string {
  const rows = doc.tests
    .map((r) => {
      const m = r.metrics || {};
      const cls = r.status === 'passed' ? 'ok' : r.status === 'skipped' ? 'skip' : 'bad';
      return `<tr class="${cls}"><td>${esc(r.file)}</td><td>${esc(r.title)}</td><td>${esc(r.status)}</td>
<td>${(r.durationMs / 1000).toFixed(2)}s</td><td><pre>${esc(JSON.stringify(m.timings ?? {}, null, 1))}</pre></td>
<td>${esc((m.transitions as string[] | undefined)?.join(' → ') ?? '')}</td><td>${esc(m.backendCalls ?? '')}</td>
<td>${esc(m.fixerRuns ?? '')} / ${esc(m.agentRuns ?? '')}</td>
<td><pre>${esc([...(((m.notes as string[]) ?? [])), r.error ?? ''].filter(Boolean).join('\n'))}</pre></td></tr>`;
    })
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Webapp lifecycle report</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--mut:#6b6b70;--ok:#e7f6ec;--bad:#fdecec;--skip:#f3f3f5;--line:#e2e2e6}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececf0;--mut:#9a9aa2;--ok:#16301f;--bad:#3a1a1a;--skip:#222226;--line:#303036}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:24px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top;text-align:left}
tr.ok{background:var(--ok)}tr.bad{background:var(--bad)}tr.skip{background:var(--skip)}pre{margin:0;white-space:pre-wrap;font-size:12px}
.m{color:var(--mut)}</style></head><body>
<h1>Webapp lifecycle</h1><p class="m">instance ${esc(doc.instance)} · ${esc(doc.finished)} · overall ${esc(doc.overall)}</p>
<table><thead><tr><th>file</th><th>scenario</th><th>status</th><th>time</th><th>timings (ms)</th><th>record transitions</th>
<th>backend calls</th><th>fixer / all runs</th><th>notes</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}
