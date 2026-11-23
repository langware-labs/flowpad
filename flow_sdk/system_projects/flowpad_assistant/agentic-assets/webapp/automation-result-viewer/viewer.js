// How an automation's result looks — the viewer for the `automation.result` kind
// (flow_sdk/schema/data_spec/automation_spec.py AutomationResult): Status, Summary, Details.
//
// Self-contained: everything comes in through `ctx` (the DOM helper `ctx.h`, the generic viewer
// `ctx.generic`, `ctx.navigate`), so this module imports nothing. Contract: ts_sdk/src/viewers/contract.ts.

export const contract = 1;

const LABEL = { done: 'Done', expired: 'Expired', cancelled: 'Cancelled', needs_review: 'Needs review', failed: 'Failed' };

function line(h, name, ...value) {
  return h('div', { class: 'ar-line' }, h('span', { class: 'ar-name' }, name), h('span', { class: 'ar-value' }, ...value));
}

const single = {
  async mount(el, req, ctx) {
    const { h } = ctx;
    const mode = req.mode || 'view';
    if (mode === 'edit' || mode === 'compare') return ctx.generic.single.mount(el, req, ctx);
    const v = req.value || {};
    const status = h('span', { class: `ar-chip ar-${v.status}`, 'data-testid': 'automation-result-status' }, LABEL[v.status] || v.status || '');
    el.replaceChildren();
    if (mode === 'line') {
      el.append(h('span', { class: 'ar-inline' }, status, h('span', {}, v.summary || '')));
      return {};
    }
    const details = v.details || [];
    const rows = h('div', { class: 'ar-details', hidden: '', 'data-testid': 'automation-result-details' },
      ...details.map((d) => line(h, d.label, d.value)));
    const toggle = details.length
      ? h('button', { class: 'ar-button', type: 'button', 'data-testid': 'automation-result-details-toggle',
          onclick: () => {
            rows.hidden = !rows.hidden;
            toggle.textContent = rows.hidden ? 'Details' : 'Hide details';
          } }, 'Details')
      : null;
    const session = v.session && ctx.navigate
      ? h('button', { class: 'ar-button', type: 'button', 'data-testid': 'automation-result-session',
          onclick: () => ctx.navigate(v.session) }, 'Open the session')
      : null;
    el.append(
      h('div', { class: 'ar-root', 'data-testid': 'automation-result-card', 'data-status': v.status || '' },
        line(h, 'Status', status),
        line(h, 'Summary', v.summary || ''),
        toggle || session ? h('div', { class: 'ar-actions' }, toggle, session) : null,
        rows));
    return {};
  },
};

export const viewers = { 'automation.result': { single } };

export const styles = `
.ar-root { display: flex; flex-direction: column; gap: .3rem; font-size: 14px; overflow-wrap: anywhere; }
.ar-line { display: flex; gap: .5rem; align-items: baseline; }
.ar-name { flex: none; width: 5.5rem; font-size: 12px; color: hsl(var(--muted-foreground)); }
.ar-value { min-width: 0; white-space: pre-wrap; }
.ar-inline { display: inline-flex; gap: .5rem; align-items: center; }
.ar-chip { display: inline-block; padding: .05rem .5rem; border-radius: 999px; font-size: 12px; font-weight: 500;
  border: 1px solid hsl(var(--border)); background: hsl(var(--muted)); color: hsl(var(--foreground)); }
.ar-done { border-color: rgb(34 197 94 / .5); background: rgb(34 197 94 / .15); }
.ar-expired, .ar-needs_review { border-color: rgb(234 179 8 / .5); background: rgb(234 179 8 / .15); }
.ar-failed { border-color: rgb(239 68 68 / .6); background: rgb(239 68 68 / .15); }
.ar-actions { display: flex; gap: .5rem; }
.ar-button { padding: .1rem .6rem; border-radius: 6px; font-size: 12px; cursor: pointer;
  border: 1px solid hsl(var(--border)); background: transparent; color: hsl(var(--foreground)); }
.ar-button:hover { background: hsl(var(--accent)); }
.ar-details { display: flex; flex-direction: column; gap: .25rem; padding-top: .25rem; border-top: 1px solid hsl(var(--border) / .6); }
.ar-details[hidden] { display: none; }
`;
