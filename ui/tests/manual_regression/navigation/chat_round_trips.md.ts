/**
 * A long chat keeps its place — docs/navigation/dock-loading.md, I6, for the chat
 * surface (FLOWPAD-2193).
 *
 * Reported on prod 0.2.179: switching away from a long chat froze the UI for
 * seconds, and a reader who had scrolled up came back to the TOP of the chat.
 * Both came from the pool moving the panel on every switch — a moved node loses
 * its layout and its scroll offset. The pool now keeps every panel in one stack
 * in the slot; only a layout change moves the stack, and it puts scroll offsets
 * back.
 *
 * Per trip, on the way back:
 *   - the SAME chat pane node is showing (a rebuild is a new node);
 *   - the reader is where they left off, not at the top or the bottom.
 *
 * Run (disposable instance with the mock worker — see ./_world.ts):
 *   VITE_PORT=5007 FLOW_INSTANCE=dlm-7 npx playwright test \
 *     --config tests/manual_regression/navigation/playwright.config.ts chat_round_trips
 */
import { expect, test, type Page } from '@playwright/test';
import {
  awaitSteerable,
  createLongChat,
  createWorld,
  destroyLongChat,
  destroyWorld,
  installObservers,
  navigateTo,
  nothingToDisplaySightings,
  toplogOn,
  type LongChat,
  type World,
} from './_world';

let world: World;
let chat: LongChat;

test.beforeAll(async () => {
  world = await createWorld('chat-trip');
  chat = await createLongChat(world);
  await toplogOn(['tab_switch']);
});

test.afterAll(async () => {
  if (chat) destroyLongChat(chat);
  if (world) await destroyWorld(world);
});

/** The chat's scrolling element — the container's first child (the second is the "scroll to bottom" button). */
const scroller = (id: string) =>
  `[data-session-id="agentic_process-${id}"] [data-testid="auto-scroll-container"] > div:first-child`;

async function readScroll(page: Page, id: string): Promise<{ top: number; max: number } | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? { top: Math.round(el.scrollTop), max: el.scrollHeight - el.clientHeight } : null;
  }, scroller(id));
}

async function pinPane(page: Page, id: string): Promise<void> {
  await page.evaluate((sel) => {
    (window as unknown as { __pinnedPane: Element | null }).__pinnedPane = document.querySelector(sel);
  }, scroller(id));
}

async function samePaneShowing(page: Page, id: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const pinned = (window as unknown as { __pinnedPane: Element | null }).__pinnedPane;
    return !!pinned && pinned === document.querySelector(sel) && (pinned as HTMLElement).offsetParent !== null;
  }, scroller(id));
}

test('a long chat keeps its place across a tab switch and a layout change', async ({ page }) => {
  await installObservers(page);
  await page.goto('/dock/desktop?viewMode=standard');
  await awaitSteerable(page);

  const other = `shell/agentic_process-${world.processId}`;
  const chatAddress = `shell/agentic_process-${chat.processId}`;
  await navigateTo(page, `${other}?viewMode=standard`, `/shell/agentic_process-${world.processId}`);
  await navigateTo(page, `${chatAddress}?viewMode=standard`, `/shell/agentic_process-${chat.processId}`);
  await expect
    .poll(async () => (await readScroll(page, chat.processId))?.max ?? 0, {
      timeout: 30_000,
      message: 'the long chat never rendered its history',
    })
    .toBeGreaterThan(50_000);

  // Read somewhere in the middle, the way a person does: with the wheel.
  await page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2);
  }, scroller(chat.processId));
  await page.locator(scroller(chat.processId)).hover();
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => (await readScroll(page, chat.processId))?.top).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  const reading = (await readScroll(page, chat.processId))!;
  expect(reading.top, 'the reader is not in the middle of the chat').toBeLessThan(reading.max - 1_000);
  await pinPane(page, chat.processId);

  const chatChip = `[data-testid="tab-shell|agentic_process-${chat.processId}"]`;
  const otherChip = `[data-testid="tab-shell|agentic_process-${world.processId}"]`;

  const trips: { name: string; away: () => Promise<void>; back: () => Promise<void> }[] = [
    {
      name: 'another tab and back (the chips)',
      away: () => page.locator(otherChip).first().click(),
      back: () => page.locator(chatChip).first().click(),
    },
    {
      name: 'the report — a different layout — and back',
      away: () =>
        navigateTo(
          page,
          `project/${world.projectId}/editor/markdown/vfs/compute_node-%40local${world.reportPath}`,
          '/editor/markdown/',
        ),
      back: () => navigateTo(page, `${chatAddress}?viewMode=standard`, `/shell/agentic_process-${chat.processId}`),
    },
  ];

  for (const trip of trips) {
    await test.step(`→ ${trip.name}`, async () => {
      await trip.away();
      await page.waitForTimeout(500);
      await trip.back();
      await expect.poll(() => samePaneShowing(page, chat.processId), { message: 'the chat was rebuilt' }).toBe(true);
      await expect
        .poll(async () => (await readScroll(page, chat.processId))?.top, {
          message: `the reader lost their place after ${trip.name}`,
        })
        .toBe(reading.top);
      expect(await nothingToDisplaySightings(page), `"nothing to display" during ${trip.name}`).toEqual([]);
    });
  }
});
