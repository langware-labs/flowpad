/**
 * Playwright harness for two-instance REAL-UI hub tests (the share matrix).
 *
 * One headless Chromium, one page per named instance (dev-1, dev-2, …) pointed
 * at that instance's Vite frontend (port from `.env.<name>.local`). Each page
 * collects console errors through the run; `realConsoleErrors` applies the
 * manual_regression noise filter so scenarios can assert a clean console after
 * opening a shared asset.
 *
 * Drivers cover the canonical share template end-to-end:
 *   driveShareDialog       — contact → conversation row → Share → success
 *   acceptInvitationInUI   — receiver clicks the strip's Accept CTA
 *   openConversation       — /dock/conversation/<id>
 *   replyInComposer        — type into "Reply to sender…" + click Send
 */
import { chromium, type Browser, type Page } from 'playwright';
import { readEnvFile } from './_instances';

export interface InstancePage {
  name: string;
  feUrl: string;
  /** The instance's backend base (http://localhost:<LOCAL_SERVER_PORT>). */
  apiUrl: string;
  page: Page;
  consoleErrors: string[];
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

/** Open a page on the instance's frontend and start collecting console errors. */
export async function openInstancePage(browser: Browser, name: string): Promise<InstancePage> {
  const env = await readEnvFile(name);
  const fePort = env.VITE_PORT;
  if (!fePort) {
    throw new Error(`instance '${name}' has no VITE_PORT in .env.${name}.local — launch it first`);
  }
  const feUrl = `http://localhost:${fePort}`;
  const apiUrl = `http://localhost:${env.LOCAL_SERVER_PORT}`;
  const page = await browser.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  await page.goto(feUrl, { waitUntil: 'domcontentloaded' });
  // `domcontentloaded` fires BEFORE React mounts and `useDockNavigation` runs its
  // `defineGlobal('navigation', …)`. Until then `window.navigation` is the native
  // (method-less) Navigation object, so a test calling `window.navigation.*`
  // right away races the app boot. Wait for the app's navigation to be installed
  // (mounts in ~0.5s) before handing the page back — a readiness gate, not a
  // timeout mask.
  await page
    .waitForFunction(
      () => typeof (window as unknown as { navigation?: { openShellProcess?: unknown } }).navigation?.openShellProcess === 'function',
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => {
      /* leave the race visible to the caller's own assertions if the app never mounts */
    });
  return { name, feUrl, apiUrl, page, consoleErrors };
}

/** The manual_regression noise filter: infra chatter that isn't an app bug. */
export function realConsoleErrors(errors: string[]): string[] {
  return errors.filter(
    (e) =>
      !e.includes('ResizeObserver') &&
      !e.includes('favicon') &&
      !e.includes('404') &&
      !e.includes('user-') &&
      !e.includes('WebSocket') &&
      !e.includes('net::ERR_') &&
      !e.includes('Failed to load resource'),
  );
}

/** Reset an instance page's console-error collection (between scenario steps). */
export function resetConsoleErrors(inst: InstancePage): void {
  inst.consoleErrors.length = 0;
}

export interface ShareDialogOptions {
  /** Recipient email typed into the contact picker. */
  recipientEmail: string;
  /** Optional note text. */
  note?: string;
  /** Optional explicit conversation title. */
  title?: string;
  /** Pick an existing conversation row by id instead of "Start new". */
  existingConversationId?: string;
}

/**
 * Drive an OPEN ShareToConversationDialog through contact → row → submit →
 * success. The caller is responsible for clicking the entry point that opens
 * the dialog. Returns once the success screen ("Shared") is visible.
 */
export async function driveShareDialog(page: Page, opts: ShareDialogOptions): Promise<void> {
  const dialog = page.getByTestId('share-to-conversation-dialog');
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });

  // The testid sits on the <input> itself (ContactPicker forwards it). The
  // Radix dialog's open animation + focus trap swallow keystrokes for a beat
  // after open — click, settle, type, and verify the value landed.
  const contact = dialog.getByTestId('share-contact-picker');
  await contact.click();
  await page.waitForTimeout(500);
  await contact.pressSequentially(opts.recipientEmail, { delay: 15 });
  if ((await contact.inputValue()) !== opts.recipientEmail) {
    await contact.fill(opts.recipientEmail);
  }
  await contact.press('Enter');

  if (opts.title !== undefined) {
    await dialog.getByTestId('share-title-input').fill(opts.title);
  }
  if (opts.note !== undefined) {
    await dialog.getByTestId('share-note-input').fill(opts.note);
  }

  await dialog.getByTestId('share-conversation-list').waitFor({ timeout: 10_000 });
  if (opts.existingConversationId) {
    await dialog.getByTestId(`share-conv-row-${opts.existingConversationId}`).click();
  } else {
    await dialog.getByTestId('share-conv-row-new').click();
  }

  await dialog.getByTestId('share-submit').click();

  // Success is the "Shared" screen. But a markdown-backed asset editor
  // (workflow/skill/plan via MarkdownEditor) can briefly re-render its host to
  // null when the just-shared entity reloads over WS, unmounting the dialog
  // mid-success. That unmount is NOT a share failure — the POSTs already
  // landed (the receiver's accept step is the real source of truth). So treat
  // EITHER the success screen OR the dialog detaching as a dispatched share;
  // only a dialog that stays open showing the form is a genuine failure.
  const status = dialog.getByTestId('share-status');
  const deadline = Date.now() + 25_000;
  for (;;) {
    if (await status.isVisible().catch(() => false)) return;
    if (!(await dialog.isVisible().catch(() => false))) return; // host unmounted it
    if (Date.now() > deadline) {
      const state = await dialog
        .innerText()
        .then((t) => t.replace(/\n+/g, ' | ').slice(0, 500))
        .catch(() => '(dialog gone)');
      throw new Error(`share did not dispatch (dialog still on the form). State: ${state}`);
    }
    await page.waitForTimeout(500);
  }
}

/**
 * Receiver side: reload home, refresh the Recent strip, and click the
 * invitation Accept CTA. Retries the refresh a few times — the invitation has
 * to sync down from the hub first.
 */
export async function acceptInvitationInUI(
  inst: InstancePage,
  conversationId?: string,
): Promise<void> {
  const { page } = inst;
  // Catch the pending invitation down from the hub FIRST, then load the page
  // once. The targeted invitation sync materializes the placeholder row
  // without dispatching catch-up work for every historical conversation; that
  // broad work contended with the subsequent accept action on long-lived
  // cycle instances.
  await fetch(`${inst.apiUrl}/api/v1/graph/invitation-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(() => undefined);
  // A known id belongs in Inbox, which renders the complete list. Going
  // through Home first launches a second conversation-list reconcile before
  // the Inbox navigation; on a long-lived instance those overlapping
  // reconciles can replace the just-materialized row between visibility and
  // click. Enter the authoritative full list once.
  await page.goto(
    conversationId ? `${inst.feUrl}/dock/inbox?viewMode=advanced` : inst.feUrl,
    { waitUntil: 'domcontentloaded' },
  );

  const accept = conversationId
    ? page
        .locator(
          `[data-testid="inbox-conversation-row"][data-conversation-id="${conversationId}"]`,
        )
        .getByTestId('inbox-accept-invitation-button')
    : page.getByTestId('accept-invitation-button').first();
  const refresh = page.getByTestId('refresh-conversations-button');
  const deadline = Date.now() + 18_000;
  for (;;) {
    if (await accept.isVisible().catch(() => false)) break;
    // Cheap in-page refresh (no reload) if the strip rendered it.
    await refresh.click({ timeout: 2_000 }).catch(() => undefined);
    if (Date.now() > deadline) {
      throw new Error(`no invitation Accept CTA appeared on ${inst.name} within 18s`);
    }
    await page.waitForTimeout(1_000);
  }
  if (conversationId) {
    // This helper owns the UI action only. The caller's next-state assertion
    // (shared chip, message text, or READY bundle) proves the asynchronous
    // accept/join/materialize pipeline completed within that scenario's
    // existing budget.
    await accept.click();
    return;
  }

  // Callers without a known conversation id retain the broad cleanup path:
  // click each visible Accept once so long-lived instance residue cannot hide
  // the invitation under test.
  const buttons = page.getByTestId('accept-invitation-button');
  const count = await buttons.count();
  for (let i = count - 1; i >= 0; i--) {
    await buttons.nth(i).click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1_500);
}

export async function openConversation(inst: InstancePage, conversationId: string): Promise<void> {
  await inst.page.goto(`${inst.feUrl}/dock/conversation/${conversationId}?viewMode=advanced`, {
    waitUntil: 'domcontentloaded',
  });
}

/**
 * Receiver-side: map an incoming (remote) conversation to a fresh, EMPTY project
 * and wait for the mapping to persist. Attachment downloads materialize assets
 * under the conversation's project, and a shared-asset chip opens that project's
 * view — mapping to a big existing project makes the project tree + editor load
 * eat the open budget, while the UI picker's optimistic PUT races the next
 * download. A dedicated empty project keeps the open fast and deterministic.
 * Mechanics use the instance's backend API (same `inst.apiUrl` probe
 * `acceptInvitationInUI` uses) — no browser injection. Returns the project dir.
 */
export async function mapConversationToProject(
  inst: InstancePage,
  conversationId: string,
): Promise<string> {
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'flowpad-mx-'));
  const created = await fetch(`${inst.apiUrl}/api/v1/graph/project`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nodePath.basename(dir), fs_storage_mount_path: dir }),
  }).then((r) => r.json());
  const projectId = created?.data?.id as string;
  await fetch(`${inst.apiUrl}/api/v1/graph/conversation/${conversationId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId }),
  });
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${inst.apiUrl}/api/v1/graph/conversation/${conversationId}`)
      .then((x) => x.json())
      .catch(() => null);
    if (r?.data?.project_id === projectId) break;
    await inst.page.waitForTimeout(250);
  }
  return dir;
}

/** Type into the conversation composer ("Reply to sender…") and send. Enter
 *  submits (the composer's keydown handler), which avoids the duplicate
 *  Send-button selector when a draft composer is also mounted. */
export async function replyInComposer(inst: InstancePage, text: string): Promise<void> {
  const composer = inst.page.getByPlaceholder('Reply to sender…');
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await composer.fill(text);
  await composer.press('Enter');
}

/** Wait until the given text is visible somewhere in the conversation view. */
export async function waitForMessageText(
  inst: InstancePage,
  text: string,
  timeoutMs = 25_000,
): Promise<void> {
  await inst.page.getByText(text, { exact: false }).first().waitFor({ timeout: timeoutMs });
}
