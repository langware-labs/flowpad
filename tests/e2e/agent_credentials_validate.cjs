/**
 * Browser validation of an agent's credentials: every credential its runs resolve (the project's,
 * then the user's) is listed under Agent resources → Credentials, and each opens NESTED in the agent
 * (`…/child/credential/<typeid>`, same tab) showing its scope, where its values live, its state and
 * each variable — checked against the backend's own status, credential by credential.
 *
 *   node tests/e2e/agent_credentials_validate.cjs <frontend> <backend> <agent id> <project id> <out dir> [--flows]
 *
 * With --flows it also drives the page (the project needs a `mixdemo-missing` and a `mixdemo-set`
 * credential): Set values on a missing one turns it "set"; `+` → a template adds it; a row's delete
 * and the page's Delete remove one, the page's returning to the agent.
 *
 * Writes <out>/report.json and shots/*.png; exits non-zero on a mismatch.
 */
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { chromium } = require('../../ui/node_modules/playwright');

const [frontend, backend, agentId, projectId, out, flag] = process.argv.slice(2);
if (!out) throw new Error('usage: agent_credentials_validate.cjs <frontend> <backend> <agent id> <project id> <out dir>');
mkdirSync(join(out, 'shots'), { recursive: true });

(async () => {
  const status = (await (await fetch(`${backend}/api/v1/graph/compute_node/@local/credentials/status?project_id=${projectId}`)).json()).data;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
      localStorage.setItem('navigator:agent-resources:section:credentials:open', '1');
    } catch { /* sandboxed */ }
  });
  const agentUrl = `${frontend}/dock/assets/editor/agent/typeid/agent-${agentId}`;
  await page.goto(agentUrl);
  await page.waitForSelector('[data-testid=navigator-section-credentials]', { timeout: 60000 });
  await page.waitForSelector('[data-testid^=agent-resource-credential-]', { timeout: 30000 });
  await page.screenshot({ path: join(out, 'shots', '00-section.png') });

  const checks = [];
  const check = (what, ok, detail = '') => {
    checks.push({ what, ok, detail });
    console.log(JSON.stringify({ ok, what, detail }));
  };

  // The list: every credential the status holds, project first, each with its scope and state.
  const listed = await page.$$eval('[data-testid^=agent-resource-credential-]', (rows) =>
    rows.map((r) => ({ id: r.getAttribute('data-testid').replace('agent-resource-credential-', ''), text: r.textContent })),
  );
  const expected = status.credentials.map((c) => `${c.scope}-${c.name}`);
  check('every credential the status holds is listed', expected.every((e) => listed.some((l) => l.id === e)) && listed.length === expected.length,
    `listed ${listed.length}, status ${expected.length}`);
  const firstUser = listed.findIndex((l) => l.id.startsWith('user-'));
  check("the project's come first", firstUser === -1 || listed.slice(firstUser).every((l) => l.id.startsWith('user-')));

  for (const [i, cred] of status.credentials.entries()) {
    const key = `${cred.scope}-${cred.name}`;
    const shadowed = cred.vars.some((v) => v.shadowed_by);
    const row = listed.find((l) => l.id === key);
    const wantState = shadowed ? "overridden by the project's" : cred.state === 'connected' ? 'set' : 'missing';
    check(`${key}: its row says scope and state`, !!row && row.text.includes(cred.scope) && row.text.includes(wantState), row?.text);

    await page.click(`[data-testid="agent-resource-credential-${key}"]`);
    await page.waitForSelector('[data-testid=credential-child]', { timeout: 15000 });
    await page.waitForTimeout(300);
    const url = page.url();
    check(`${key}: opens nested in the agent`, url.startsWith(agentUrl) && url.includes(`/child/credential/${cred.typeid}`), url);
    const scope = await page.textContent('[data-testid=credential-child-scope]');
    check(`${key}: scope badge`, scope.trim() === cred.scope, scope);
    const store = await page.textContent('[data-testid=credential-child-store]');
    check(`${key}: where its values live`, cred.value_store === 'vault' ? store.includes('vault') : store.includes('.env.local'), store);
    const state = await page.textContent('[data-testid=credential-child-state]');
    check(`${key}: state`, state.includes(wantState), state);
    for (const v of cred.vars) {
      const text = await page.textContent(`[data-testid="credential-var-${v.env_var}"]`);
      const want = v.present ? 'set' : v.required ? 'missing' : 'optional · not set';
      check(`${key}: ${v.env_var} reads "${want}"`, text.includes(want), text);
      if (v.warning === 'wrong-store') {
        check(`${key}: ${v.env_var} says it is in the wrong store`, (await page.$(`[data-testid="credential-var-warning-${v.env_var}"]`)) !== null);
      }
    }
    if (shadowed) check(`${key}: says the project overrides it`, (await page.$('[data-testid=credential-child-shadowed]')) !== null);
    const crumbs = await page.textContent('nav, [data-testid*=breadcrumb]').catch(() => '');
    check(`${key}: breadcrumbs name Credentials`, (crumbs || '').includes('Credentials'), (crumbs || '').slice(0, 120));
    await page.screenshot({ path: join(out, 'shots', `${String(i + 1).padStart(2, '0')}-${key}.png`) });
  }

  if (flag === '--flows') {
    const rowText = async (key) => (await page.$(`[data-testid="agent-resource-credential-${key}"]`))?.textContent() ?? null;
    const until = async (what, fn, seconds = 10) => {
      for (let i = 0; i < seconds * 4; i++) {
        if (await fn()) return check(what, true);
        await page.waitForTimeout(250);
      }
      check(what, false);
    };
    const confirm = () => page.click('[role=alertdialog] button:has-text("Delete")');

    // Set values on a missing credential, in its page.
    await page.click('[data-testid="agent-resource-credential-project-mixdemo-missing"]');
    await page.waitForSelector('[data-testid=credential-child]');
    await page.click('[data-testid=credential-child-set-values]');
    await page.fill('[data-testid=credential-var-value-0]', 'filled-by-the-page');
    await page.click('[data-testid=credential-save]');
    await until('Set values: the page reads "set"', async () => (await page.textContent('[data-testid=credential-child-state]')).includes('set'));
    await until('Set values: its row reads "project · set"', async () => (await rowText('project-mixdemo-missing'))?.includes('project · set'));
    await page.screenshot({ path: join(out, 'shots', 'flow-1-values-set.png') });

    // + → a template.
    await page.click('[data-testid=agent-resource-add-credential]');
    await page.click('[data-testid=add-connection-twilio]');
    // Its variables are required: the form refuses to add it empty.
    await page.click('[data-testid=credential-save]');
    check('+ → template: the form refuses required values left empty', (await page.$('[data-testid=credential-dialog]')) !== null);
    // …and a value that does not match its pattern.
    await page.fill('[data-testid=credential-var-value-0]', 'ACdemo');
    await page.fill('[data-testid=credential-var-value-1]', 'demo-token');
    await page.click('[data-testid=credential-save]');
    check('+ → template: the form refuses a value off its pattern', (await page.$('[data-testid=credential-dialog]')) !== null);
    await page.fill('[data-testid=credential-var-value-0]', 'AC' + '0'.repeat(32));
    await page.fill('[data-testid=credential-var-value-1]', 'demo-token');
    await page.click('[data-testid=credential-save]');
    await until('+ → template: its row appears in the project', async () => (await rowText('project-twilio')) !== null);
    await page.screenshot({ path: join(out, 'shots', 'flow-2-template-added.png') });

    // A row's delete.
    await page.hover('[data-testid="agent-resource-credential-project-mixdemo-set"]');
    await page.click('[data-testid="agent-resource-delete-credential-project-mixdemo-set"]');
    await confirm();
    await until("a row's delete removes it", async () => (await rowText('project-mixdemo-set')) === null);

    // The page's Delete — and back to the agent.
    await page.click('[data-testid="agent-resource-credential-project-twilio"]');
    await page.waitForSelector('[data-testid=credential-child]');
    await page.click('[data-testid=credential-child-delete]');
    await confirm();
    await until("the page's Delete removes it and returns to the agent", async () =>
      (await rowText('project-twilio')) === null && !page.url().includes('/child/'));
    await page.screenshot({ path: join(out, 'shots', 'flow-3-deleted.png') });
  }

  const failed = checks.filter((c) => !c.ok).length;
  writeFileSync(join(out, 'report.json'), JSON.stringify({ checks, failed }, null, 2));
  console.log(JSON.stringify({ done: true, checks: checks.length, failed }));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(2);
});
