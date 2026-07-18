/**
 * Share-over-conversation matrix — REAL UI on BOTH sides.
 *
 * Every scenario walks the four steps the product defines for any share:
 *   1. share    — sender performs the share through the real entry-point UI
 *   2. accept   — receiver sees the invitation in its UI and accepts it
 *   3. open     — receiver opens the shared asset; it renders with a clean
 *                 console (manual_regression noise filter applied)
 *   4. reply    — receiver replies in the composer; sender sees it arrive
 *
 * Entry points: asset-page share (workflow — the MarkdownEditor share button
 * every md-backed editor inherits; whiteboard — the AssetEditorHeader button)
 * and message forward. Assets are seeded via each instance's SDK realm; every
 * share/accept/open/reply interaction is a real browser click (Playwright,
 * headless Chromium).
 *
 * All scenarios drive the full four-step loop. A/B step 3 (open the shared
 * asset) exercises the receiver body-bundle path: the matrix originally found
 * that shared workflow/whiteboard entities never materialized on the receiver
 * (their bytes weren't packed, and their ids weren't carried) — now fixed in
 * `flow_message_bundle.py` (workflow/whiteboard added to `_FS_ROOTED_TYPES` +
 * sender id injected into the main doc's frontmatter so the receiver
 * materializes the SAME entity). Forward (C) needs no body bundle.
 *
 * Note: scenarios share browser pages, so all-green-in-one-run can be timing
 * flaky on a busy host (each passes individually); per-`describe` contexts
 * would isolate them further.
 *
 * Requires the explicit SHARE_INST_1/SHARE_INST_2 pair with live frontends and
 * the cycle-owned FLOWPAD_HUB_URL. Skips when the hub or instances aren't up.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { testEntityName, trackForCleanup, trackTypeId } from '../_cleanup';
import { hubAvailable } from './_hub';
import {
  HUB_INST_1 as INST_1,
  HUB_INST_2 as INST_2,
  getInstance,
  instanceAvailable,
  type ResolvedInstance,
} from './_instances';
import {
  acceptInvitationInUI,
  driveShareDialog,
  launchBrowser,
  mapConversationToProject,
  openConversation,
  openInstancePage,
  realConsoleErrors,
  replyInComposer,
  resetConsoleErrors,
  waitForMessageText,
  type InstancePage,
} from './_browser';

let skipReason: string | null = null;
let dev1: ResolvedInstance;
let dev2: ResolvedInstance;
let browser: Browser;
let p1: InstancePage; // sender's window
let p2: InstancePage; // receiver's window

const ts = Date.now();

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!instanceAvailable(INST_1) || !instanceAvailable(INST_2)) {
    return void (skipReason = `launch ${INST_1} + ${INST_2} via scripts/instance_ctl.sh`);
  }
  dev1 = await getInstance(INST_1);
  dev2 = await getInstance(INST_2);
  browser = await launchBrowser();
  p1 = await openInstancePage(browser, INST_1);
  p2 = await openInstancePage(browser, INST_2);

  // Warm the editor routes once: the Vite dev server cold-transforms the
  // Milkdown/Monaco/Excalidraw bundles on first hit, which would otherwise
  // eat A1/B1's 30s budget. This is fixture warming, not a timeout bump.
  const warm = trackForCleanup(await dev1.sdk.DynamicWorkflow.createInProject(null, testEntityName('workflow')));
  await p1.page.goto(`${p1.feUrl}/dock/assets/editor/workflow/typeid/workflow-${warm.id}?viewMode=advanced`, {
    waitUntil: 'domcontentloaded',
  });
  const warmShare = p1.page.getByTestId('markdown-editor-share');
  await warmShare.waitFor({ timeout: 60_000 }).catch(() => undefined);
  // Open + close the share dialog once too: its chunk, the contact picker,
  // and the conversations-for-contacts query all cold-load on first open.
  if (await warmShare.isVisible().catch(() => false)) {
    await warmShare.click().catch(() => undefined);
    await p1.page
      .getByTestId('share-to-conversation-dialog')
      .waitFor({ timeout: 30_000 })
      .catch(() => undefined);
    await p1.page.keyboard.press('Escape');
    await p1.page.waitForTimeout(500);
  }

  // Warm the RECEIVER's (p2) editor bundles too — p2 is a SEPARATE Vite dev
  // server, so the first editor open (A3) would otherwise cold-transform the
  // Milkdown/Excalidraw bundles. Route to each editor once to trigger it.
  const warmWf2 = trackForCleanup(await dev2.sdk.DynamicWorkflow.createInProject(null, testEntityName('workflow')));
  await p2.page.goto(`${p2.feUrl}/dock/assets/editor/workflow/typeid/workflow-${warmWf2.id}?viewMode=advanced`, {
    waitUntil: 'domcontentloaded',
  });
  await p2.page.locator('[data-testid="md-editor-with-side-panel"]').waitFor({ timeout: 60_000 }).catch(() => undefined);
  const warmWb2 = trackForCleanup(await dev2.sdk.Whiteboard.create(testEntityName('whiteboard')));
  await p2.page.goto(`${p2.feUrl}/dock/assets/editor/whiteboard/typeid/whiteboard-${warmWb2.id}?viewMode=advanced`, {
    waitUntil: 'domcontentloaded',
  });
  await p2.page.locator('[data-testid="whiteboard-editor"]').waitFor({ timeout: 60_000 }).catch(() => undefined);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  // This matrix materializes entities on BOTH instances (Alice creates + shares;
  // Bob receives copies). The global single-realm leak sweep can't reach the
  // far side, so purge our e2etest-* rows on both backends directly — pure
  // teardown hygiene so the leftover detector stays green.
  if (!skipReason && dev1 && dev2) {
    const SWEEP = ['conversation', 'skill', 'agent', 'workflow', 'whiteboard', 'markdown', 'spec', 'prompt'];
    for (const inst of [dev1, dev2]) {
      for (const type of SWEEP) {
        const list = await fetch(`${inst.apiUrl}/api/v1/graph/${type}`).then((r) => r.json()).catch(() => null);
        for (const r of (list?.data ?? []) as any[]) {
          const label = String(r?.title ?? r?.name ?? '');
          if (label.startsWith('e2etest-') && r?.id) {
            await fetch(`${inst.apiUrl}/api/v1/graph/${type}/${r.id}`, { method: 'DELETE' }).catch(() => undefined);
          }
        }
      }
    }
  }
});

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

/** Resolve a just-created conversation by its (unique, ts-stamped) title via
 *  the sender's backend — host-independent, so it works whether or not the
 *  share dialog's success screen survived the host re-render. */
async function conversationIdByTitle(inst: ResolvedInstance, title: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const r = await fetch(`${inst.apiUrl}/api/v1/graph/conversation?limit=100`).then((x) => x.json());
    const rows: Array<{ id: string; title?: string }> = r?.data ?? [];
    const hit = rows.find((c) => c.title === title);
    if (hit) return hit.id;
    if (Date.now() > deadline) throw new Error(`no conversation titled "${title}" on ${inst.name}`);
    await new Promise((res) => setTimeout(res, 500));
  }
}

/** Receiver-side: pull the body bundle (when the message carries one) and
 *  open the shared asset via its chip; assert the console stays clean. */
async function downloadAndOpenAssetClean(
  inst: InstancePage,
  conversationId: string,
  chipTestId: string,
  editorReadySelector: string,
): Promise<void> {
  await openConversation(inst, conversationId);
  // Map a fresh empty project FIRST — the asset copies there and the shared-asset
  // chip opens that project's view; an empty project keeps the open fast.
  await mapConversationToProject(inst, conversationId);
  const download = inst.page.getByTestId('download-attachments-button');
  // Sender uploads the body in the background — wait out UPLOADING, then click
  // Download. The chip flips from disabled ("not found locally") to enabled the
  // instant the receive path's CREATE data_op lands (no reload) — that's the
  // _notify_received_assets fix; without it the chip stays disabled forever.
  const deadline = Date.now() + 22_000;
  for (;;) {
    if (await inst.page.getByTestId(chipTestId).first().isVisible().catch(() => false)) break;
    const visible = await download.first().isVisible().catch(() => false);
    if (visible && (await download.first().isEnabled().catch(() => false))) {
      await download.first().click().catch(() => undefined);
    }
    if (Date.now() > deadline) throw new Error(`chip ${chipTestId} never appeared on ${inst.name}`);
    await inst.page.waitForTimeout(400);
  }

  // STAGED RECEPTION (f1276cd5): download STAGES the asset (MessageAttachment,
  // scope=null) — the chip renders dashed and opens the review/install modal,
  // never the editor (consent boundary). Install explicitly into the mapped
  // project via the modal's backend action, then open the editor at its dock
  // URL — the same target the context panel's Open resolves. (The chip→modal
  // UX has its own coverage; this test's assertion target stays "the shared
  // asset opens cleanly in the receiver's editor".)
  const chipMatch = /^entity-chip-([a-z_]+)-(.+)$/.exec(chipTestId);
  if (!chipMatch) throw new Error(`unexpected chip testid ${chipTestId}`);
  const [, assetType, assetId] = chipMatch;
  const convRow = await fetch(`${inst.apiUrl}/api/v1/graph/conversation/${conversationId}`)
    .then((r) => r.json()).catch(() => null);
  const projectId = convRow?.data?.project_id as string;
  let staged: any = null;
  const stagedDeadline = Date.now() + 10_000;
  while (!staged && Date.now() < stagedDeadline) {
    const rows = await fetch(`${inst.apiUrl}/api/v1/graph/message_attachment`)
      .then((r) => r.json()).catch(() => null);
    staged = ((rows?.data ?? []) as any[]).find(
      (m) => m.conversation_id === conversationId && m.asset_id === assetId,
    ) ?? null;
    if (!staged) await inst.page.waitForTimeout(400);
  }
  if (!staged) throw new Error(`staged MessageAttachment for ${assetType}-${assetId} never appeared on ${inst.name}`);
  const install = await fetch(`${inst.apiUrl}/api/v1/graph/message_attachment/${staged.id}/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'project', project_id: projectId }),
  }).then((r) => r.json());
  if (install?.status !== 'SUCCESS') {
    throw new Error(`install failed on ${inst.name}: ${JSON.stringify(install?.message)}`);
  }

  resetConsoleErrors(inst);
  await inst.page.goto(
    `${inst.feUrl}/dock/assets/editor/${assetType}/typeid/${assetType}-${assetId}?viewMode=advanced`,
    { waitUntil: 'domcontentloaded' },
  );
  // Assert the editor CONTAINER attaches (it mounts when the asset resolves) +
  // a clean console — NOT a late toolbar button or strict dock-tab visibility,
  // which lag the actual open by tens of seconds in the dock split view.
  await inst.page.locator(editorReadySelector).first().waitFor({ state: 'attached', timeout: 15_000 });
  // Give late async errors a beat to surface before asserting.
  await inst.page.waitForTimeout(1_000);
  expect(realConsoleErrors(inst.consoleErrors)).toEqual([]);
}

// ─── Scenario A: asset-page share — workflow (MarkdownEditor share button) ───
// Workflow (not skill): it has a default_body_fn, so a bare SDK create
// materializes the .md and the editor mounts fully. (A skill create writes
// only the DB row — the editor sits on its missing-file card, which has no
// share affordance. That's the product's current shape, not a test gap.)

describe('A. asset-page share: workflow', () => {
  let workflowId: string;
  let convId: string;
  const replyText = `wf-reply-${ts}`;

  const convTitle = testEntityName('conv');

  it('A1 share — dev-1 shares from the workflow editor UI', async () => {
    const wf = trackForCleanup(await dev1.sdk.DynamicWorkflow.createInProject(null, testEntityName('workflow')));
    workflowId = wf.id!;
    await p1.page.goto(`${p1.feUrl}/dock/assets/editor/workflow/typeid/workflow-${workflowId}?viewMode=advanced`, {
      waitUntil: 'domcontentloaded',
    });
    await p1.page.getByTestId('markdown-editor-share').click({ timeout: 20_000 });
    await driveShareDialog(p1.page, {
      recipientEmail: dev2.email,
      note: `here is a workflow ${ts}`,
      title: convTitle,
    });
    convId = await conversationIdByTitle(dev1, convTitle);
    trackTypeId('conversation', convId);
    expect(convId).toBeTruthy();
  });

  it('A2 accept — dev-2 accepts the invitation in its UI', async () => {
    await acceptInvitationInUI(p2);
  });

  // Receiver materialization: the body bundle downloads, unpacks, and
  // materializes the shared workflow under the SAME id (the packer now adds
  // workflow/whiteboard to `_FS_ROOTED_TYPES` and injects the sender id into
  // the asset's main doc — see flow_message_bundle.py). The chip then resolves
  // and opens the editor with a clean console.
  it('A3 open — dev-2 opens the shared workflow with a clean console', async () => {
    await downloadAndOpenAssetClean(
      p2,
      convId,
      `entity-chip-workflow-${workflowId}`,
      '[data-testid="md-editor-with-side-panel"]',
    );
  });

  it('A4 reply — dev-2 replies; dev-1 sees it arrive', async () => {
    await openConversation(p2, convId);
    await mapConversationToProject(p2, convId); // composer send is project-gated
    await replyInComposer(p2, replyText);
    await openConversation(p1, convId);
    await waitForMessageText(p1, replyText);
  });
});

// ─── Scenario B: asset-page share — whiteboard (AssetEditorHeader button) ────

describe('B. asset-page share: whiteboard', () => {
  let wbId: string;
  let convId: string;
  const replyText = `wb-reply-${ts}`;
  const wbName = testEntityName('whiteboard');
  const convTitle = testEntityName('conv');

  it('B1 share — dev-1 shares from the whiteboard editor UI', async () => {
    const wb = trackForCleanup(await dev1.sdk.Whiteboard.create(wbName));
    wbId = wb.id!;
    // Whiteboard files materialize lazily on first editor persist; a fresh
    // entity has an empty folder and the board.json read never settles. Seed
    // the minimal board files the way the editor's first save would (the
    // instances run on this host, and asset_ref is a real local path).
    const assetRef = (wb as { asset_ref?: string }).asset_ref;
    if (assetRef) {
      const { promises: nodeFs } = await import('node:fs');
      await nodeFs.mkdir(assetRef, { recursive: true });
      await nodeFs.writeFile(
        `${assetRef}/board.json`,
        JSON.stringify({ kind: 'excalidraw', version: 1, data: { elements: [] } }),
      );
      await nodeFs.writeFile(`${assetRef}/WHITE_BOARD.md`, `# ${wbName}\n`);
    }
    await p1.page.goto(`${p1.feUrl}/dock/assets/editor/whiteboard/typeid/whiteboard-${wbId}?viewMode=advanced`, {
      waitUntil: 'domcontentloaded',
    });
    // Wait for the editor to finish mounting (board.json read settles) before
    // the share click — clicking mid-mount is what intermittently dropped the
    // share dispatch.
    await p1.page.getByTestId('whiteboard-editor').waitFor({ timeout: 25_000 });
    await p1.page.getByTestId('whiteboard-editor-share').click({ timeout: 25_000 });
    await driveShareDialog(p1.page, {
      recipientEmail: dev2.email,
      note: `here is a whiteboard ${ts}`,
      title: convTitle,
    });
    convId = await conversationIdByTitle(dev1, convTitle);
    trackTypeId('conversation', convId);
    expect(convId).toBeTruthy();
  });

  it('B2 accept — dev-2 accepts the invitation in its UI', async () => {
    await acceptInvitationInUI(p2);
  });

  // Receiver materializes the shared whiteboard under the same id (see A3) —
  // its folder rides the bundle and the id is injected into WHITE_BOARD.md.
  it('B3 open — dev-2 opens the shared whiteboard with a clean console', async () => {
    await downloadAndOpenAssetClean(
      p2,
      convId,
      `entity-chip-whiteboard-${wbId}`,
      '[data-testid="whiteboard-editor"]',
    );
  });

  it('B4 reply — dev-2 replies; dev-1 sees it arrive', async () => {
    await openConversation(p2, convId);
    await mapConversationToProject(p2, convId); // composer send is project-gated
    await replyInComposer(p2, replyText);
    await openConversation(p1, convId);
    await waitForMessageText(p1, replyText);
  });
});

// ─── Scenario C: forward a message into a new conversation ──────────────────

describe('C. forward a message', () => {
  let srcConvId: string;
  let fwdConvId: string;
  const fwdDstTitle = testEntityName('conv');

  it('C1 seed — dev-1 has a conversation with a sent message', async () => {
    // Seed a source conversation with a text message via the SDK (the entry
    // point under test is the FORWARD UI, not this send).
    const conv = trackForCleanup(new dev1.sdk.Conversation({ title: testEntityName('conv') }));
    await conv.save();
    await conv.share([dev2.email]);
    const r = await fetch(`${dev1.apiUrl}/api/v1/graph/conversation/${conv.id}/add_message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `forward me ${ts}` }),
    }).then((x) => x.json());
    expect(r.data?.flow_message_id).toBeTruthy();
    srcConvId = conv.id!;
  });

  it('C2 forward — dev-1 forwards the message via the bubble UI', async () => {
    await openConversation(p1, srcConvId);
    await waitForMessageText(p1, `forward me ${ts}`);
    await p1.page.getByTestId('message-forward').first().click({ timeout: 15_000 });
    await driveShareDialog(p1.page, {
      recipientEmail: dev2.email,
      title: fwdDstTitle,
    });
    fwdConvId = await conversationIdByTitle(dev1, fwdDstTitle);
    trackTypeId('conversation', fwdConvId);
    expect(fwdConvId).not.toBe(srcConvId);
  });

  it('C3 provenance — the clone renders the forwarded marker on dev-1', async () => {
    await openConversation(p1, fwdConvId);
    await waitForMessageText(p1, `forward me ${ts}`);
    await p1.page.getByTestId('message-forwarded-marker').first().waitFor({ timeout: 15_000 });
  });

  it('C4 accept + receive — dev-2 accepts and sees the forwarded text', async () => {
    await acceptInvitationInUI(p2);
    await openConversation(p2, fwdConvId);
    await waitForMessageText(p2, `forward me ${ts}`);
  });
});
