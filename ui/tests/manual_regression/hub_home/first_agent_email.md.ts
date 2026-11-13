import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * first_agent_email.md — the hub-home wizard on the email channel, end to end: a real agent, its real
 * address, its real sandbox, and a real mail answered there.
 *
 *   VITE_PORT=4098 npx playwright test --config tests/manual_regression/hub_home/playwright.config.ts
 *
 * The sender is a second agent made the same way (its own address): the hub's `mailbox/send` from it is a
 * real delivery, so the test needs no outside mailbox. Both mailboxes are released at the end.
 */

const PROMPT = 'Answer emails about our opening hours: Sunday to Friday 9-18, Saturday 10-16. Reply in one line.';
const made: string[] = [];
const HUB = { 'Hub-Reflect': 'true' };

async function api<T>(request: APIRequestContext, method: 'get' | 'post' | 'delete', path: string, data?: object) {
  // The hub's rows: through this desktop the call is forwarded (`Hub-Reflect`), as the SDK does.
  const r = await request[method](`/api/v1/graph/${path}`, { headers: HUB, ...(data ? { data } : {}) });
  expect(r.status(), `${method} ${path}: ${await r.text()}`).toBeLessThan(400);
  return ((await r.json()) as { data: T }).data;
}

async function walkToAddress(page: Page) {
  await page.goto('/dock/hub/home');
  const tiles = page.locator('[data-testid^=first-agent-channel-]');
  await expect(tiles.first()).toHaveAttribute('data-testid', 'first-agent-channel-email', { timeout: 60_000 });
  await expect(page.getByTestId('first-agent-close')).toHaveCount(0);
  await page.getByTestId('first-agent-channel-email').click();
  await expect(page.getByTestId('first-agent-close')).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(0); // the wizard stands alone
  await page.getByTestId('first-agent-prompt').fill(PROMPT);
  await page.getByTestId('first-agent-next').click();
  const gmail = page.getByTestId('first-agent-option-own_gmail');
  await expect(gmail).toBeDisabled();
  await expect(gmail).toContainText('support@langware.ai');
  await page.getByTestId('first-agent-option-agent_email').click();
  const created = page.waitForResponse((r) => r.url().includes('/project/create_agent'));
  await page.getByTestId('first-agent-create').click();
  const body = (await (await created).json()) as {
    data: { agent: { id: string }; mailbox: { address: string; allowed_senders: string[] } };
  };
  expect(body.data?.agent, `create_agent answered: ${JSON.stringify(body)}`).toBeTruthy();
  made.push(body.data.agent.id);
  await expect(page.getByTestId('first-agent-address')).toHaveText(body.data.mailbox.address);
  await expect(page.getByTestId('first-agent-mailbox-senders')).toContainText(body.data.mailbox.allowed_senders[0]);
  return body.data;
}

test.afterAll(async ({ request }) => {
  for (const id of made)
    await request.delete(`/api/v1/graph/agent/${id}/mailbox`, { headers: HUB }).catch(() => undefined);
});

test('email first: the wizard ends with an agent that answers my mail', async ({ page, request }) => {
  // The sender: a second agent's address, made through the same wizard (and so the same hub call).
  const sender = await walkToAddress(page);
  await page.getByTestId('first-agent-close').click();
  await expect(page.getByTestId('first-agent-channel-email')).toBeVisible();
  await expect(page.getByRole('tablist').first()).toBeVisible(); // × closes: the home page is back

  const started = Date.now();
  const agent = await walkToAddress(page);
  await page.getByTestId('first-agent-mailbox-add-input').fill(sender.mailbox.address);
  await page.getByTestId('first-agent-mailbox-add').click();
  await expect(page.getByTestId('first-agent-mailbox-senders')).toContainText(sender.mailbox.address);

  const done = page.getByTestId('first-agent-done');
  await expect(done).toBeEnabled({ timeout: 4 * 60_000 }); // the agent's machine is up
  await done.click();
  await expect(page.getByTestId('first-agent-live')).toContainText(agent.mailbox.address);
  console.log(`[first-agent-email] live after ${((Date.now() - started) / 1000).toFixed(1)}s`);

  // A new mailbox sends only to its owner (its Sending list, 29194d4c8): open the sender's to the agent.
  await api(request, 'post', `agent/${sender.agent.id}/mailbox/configure`, {
    allowed_recipients: [agent.mailbox.address],
  });
  await api(request, 'post', `agent/${sender.agent.id}/mailbox/send`, {
    to: [agent.mailbox.address],
    subject: 'Opening hours',
    text: 'Are you open on Saturday?',
  });
  const messages = page.getByTestId('first-agent-message');
  await expect(messages.filter({ hasText: 'Saturday' }).first()).toBeVisible({ timeout: 2 * 60_000 });
  await expect(messages).toHaveCount(2, { timeout: 2 * 60_000 }); // the mail, and the agent's answer
  const reply = await api<{ messages: { subject: string }[] }>(
    request,
    'get',
    `agent/${sender.agent.id}/mailbox/messages?labels=received`,
  );
  expect(reply.messages.map((m) => m.subject)).toContain('Re: Opening hours');
});
