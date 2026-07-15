/**
 * Conversation title rename-on-click + live cross-client update.
 * Source: conversation_title_rename_live.md
 *
 * Renaming the conversation header title in one client updates every other
 * client viewing the same conversation, via:
 *   save() -> PUT /conversation/<id> -> data_op UPDATE broadcast over local WS
 *   -> other client's useEntity subscriber re-renders the header.
 *
 * Two independent browser CONTEXTS (separate WS connections) on the same backend
 * are the proper "two clients". A conversation is seeded via the entity API.
 */
import { test, expect, type Page } from '@playwright/test';
import { apiBase, apiContext } from '../_shared/api';

const API = apiBase();
const titleSel = '[data-testid="conversation-title"]';
const inputSel = '[data-testid="conversation-title-input"]';

async function openConversation(page: Page, convId: string) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
  await page.goto(`/dock/conversation/${convId}`);
  const skip = page.getByRole('button', { name: /Skip( for now)?/ });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();
  await page.locator(titleSel).waitFor({ state: 'visible', timeout: 30_000 });
}

test('test 1-3: rename in one client live-updates the other client', async ({ browser }) => {
  test.setTimeout(60_000);

  // Seed a conversation via the entity API.
  const rq = await apiContext();
  const seedTitle = `qa-rename-seed-${Date.now()}`;
  const created = await (await rq.post(`${API}/api/v1/graph/conversation`, { data: { title: seedTitle } })).json();
  expect(created.status).toBe('SUCCESS');
  const convId: string = created.data.id;
  expect(convId).toMatch(/^[0-9a-f-]{36}$/);
  await rq.dispose();

  // Two independent contexts = two clients with separate WS connections.
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const tab1 = await ctx1.newPage();
  const tab2 = await ctx2.newPage();

  try {
    // Step 1: open the SAME conversation in both tabs; both show the title span
    // with the rename tooltip and the seeded title.
    await openConversation(tab1, convId);
    await openConversation(tab2, convId);
    // The header title span tooltips the FULL title (d86c9bae made the route
    // header the editable title; the old "Click to rename" tooltip is gone).
    await expect(tab1.locator(titleSel)).toHaveAttribute('title', seedTitle);
    await expect(tab1.locator(titleSel)).toContainText(seedTitle);
    await expect(tab2.locator(titleSel)).toContainText(seedTitle);

    // Step 2: rename in tab 1 (click the title via React onClick, fill, Enter).
    const newTitle = `renamed-via-ui-2tabs-${Date.now()}`;
    await tab1.locator(titleSel).evaluate((el: HTMLElement) => el.click());
    const input = tab1.locator(inputSel);
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(newTitle);
    await input.press('Enter');
    // Tab 1's input reverts to the span showing the new title.
    await expect(tab1.locator(titleSel)).toContainText(newTitle, { timeout: 10_000 });

    // Step 3: tab 2 (untouched) reflects the new title via the data_op broadcast.
    await expect(tab2.locator(titleSel)).toContainText(newTitle, { timeout: 15_000 });
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
});
