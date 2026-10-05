/** Shared steps for specs that drive a conversation: the graph API envelope, the first-run
 *  modal, and the composer's / feed's locators. */
import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

/** One `/api/v1<route>` call; fails the test unless it answers the SUCCESS envelope. */
export async function graphCall<T = Record<string, unknown>>(
  api: APIRequestContext,
  method: 'get' | 'post' | 'delete',
  route: string,
  data?: unknown,
): Promise<T> {
  const res = await api[method](`/api/v1${route}`, data === undefined ? undefined : { data });
  const json = await res.json();
  expect(res.ok() && json.status === 'SUCCESS', `${method} ${route}: ${JSON.stringify(json).slice(0, 300)}`).toBeTruthy();
  return json.data as T;
}

/** Keep the first-run LLM setup modal from covering the page. */
export async function skipLlmSetup(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame */
    }
  });
}

/** The composer's Send button (not the session toolbar's). */
export const sendButton = (page: Page) => page.locator('button[title="Send"]:not([data-testid])');

/** The first message bubble in the feed holding `text`. */
export const messageBubble = (page: Page, text: string) =>
  page.locator('[data-testid^="message-bubble-"]', { hasText: text }).first();
