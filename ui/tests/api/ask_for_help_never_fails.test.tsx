/**
 * Asking for help must never fail — the UI legs, on the real path.
 *
 * Runs only when the rig is named (HELPER_EMAIL set), against a real hub-logged-in backend (the requester) with a second instance as the
 * helper, both on the same local hub:
 *
 *   FLOW_INSTANCE=askst-3 HELPER_API=http://localhost:6023 HUB=http://localhost:8093 \
 *   HELPER_EMAIL=askst-4@local.test HELPER_PW=askst-4-pw-1234 vitest --project api <this>
 *
 * Each test breaks ONE thing the way it breaks for real — a single request that does not come
 * back, a dialog closed early, a login window closed, an instance that is offline — and asserts
 * what "never fails" has to mean: the request is not lost, not duplicated, and the user is told.
 * Ground truth for delivery is the hub's own rows, read as the helper.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { dataContext, dataManager, oauthService, Project, systemTools } from '@sdk';
import { cloudManager } from '@sdk/services/cloud_login';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { HelpdeskAsk } from '@src/components/helpdesk/HelpdeskAsk';
import { HelpdeskLoadDialog } from '@src/components/helpdesk/HelpdeskLoadDialog';
import { notify } from '@src/notifications';
import { AskForHelpDialog } from '@src/components/help/AskForHelpDialog';
import { apiTestSetup, getTestSignupInfo, trackCreatedRows } from '../utils/test-utils';

// The portal's chat surface is not under test — only whether a person is reachable beside it.
vi.mock('@src/components/entity-execution-panel', () => ({
  EntityExecutionPanel: () => <div data-testid="support-agent-chat" />,
}));
// The real desk ships `.claude/agents/support.md`, so on every real install this hook finds an agent.
vi.mock('@src/components/helpdesk/useHelpdeskAgent', () => ({
  HELPDESK_AGENT_NAME: 'support',
  useHelpdeskAgent: () => ({
    agent: { id: 'a0000000-0000-4000-8000-000000000001', asset_ref: 'support.md' },
    ready: true,
  }),
}));

const HUB = process.env.HUB ?? 'http://localhost:8093';
const HELPER_API = process.env.HELPER_API ?? 'http://localhost:6023';
const HELPER_EMAIL = process.env.HELPER_EMAIL ?? '';
const HELPER_PW = process.env.HELPER_PW ?? '';
/** How long delivery is given, polled. */
const DEADLINE_MS = 15000;

// ---------------------------------------------------------------------------
// Faults: one request that does not come back
// ---------------------------------------------------------------------------

/** The next call of `action` fails like a dropped connection; every other call is real. */
function failOnce(action: string) {
  const real = dataManager.callAction.bind(dataManager);
  let armed = true;
  return vi.spyOn(dataManager, 'callAction').mockImplementation(async (info) => {
    if (armed && info.name === action) {
      armed = false;
      throw new Error(`injected: ${action} did not come back`);
    }
    return real(info);
  });
}

// ---------------------------------------------------------------------------
// The helper's side — the hub, read as them
// ---------------------------------------------------------------------------

let helperToken = '';
async function asHelper<T>(p: string): Promise<T> {
  const r = await fetch(`${HUB}/api/v1${p}`, { headers: { Authorization: `Bearer ${helperToken}` } });
  if (!r.ok) throw new Error(`hub GET ${p} → ${r.status}`);
  return ((await r.json()) as { data: T }).data;
}

/** What the helper received for this ask: their conversations with this title, and each one's messages. */
async function helperReceived(title: string) {
  const convs = (await asHelper<{ id: string; title?: string }[]>('/graph/conversation')).filter(
    (c) => c.title === title,
  );
  return Promise.all(
    convs.map(async (c) => ({
      id: c.id,
      messages: await asHelper<{ text?: string }[]>(`/graph/conversation/${c.id}/flow_message`),
    })),
  );
}

async function eventually<T>(probe: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  const end = Date.now() + DEADLINE_MS;
  let v = await probe();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 500));
    v = await probe();
  }
  return v;
}

/** The helper instance's own hub socket — "the helper is offline" is this being down. */
const helperSocket = (verb: 'connect' | 'disconnect') =>
  fetch(`${HELPER_API}/api/v1/cloud/ws/${verb}`, { method: 'POST' });

// ---------------------------------------------------------------------------
// Driving the Vibe dialog the way a person does
// ---------------------------------------------------------------------------

/** The dialog as the toolbar button mounts it: only while open, so closing unmounts it. */
function AskHost({ onAssigned }: { onAssigned: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  return open ? (
    <MemoryRouter>
      <AskForHelpDialog
        open
        onOpenChange={setOpen}
        projectId={null}
        origin="vibe"
        onAsked={(r) => onAssigned(r.task_id ?? r.conversation_id)}
      />
    </MemoryRouter>
  ) : (
    <div data-testid="dialog-closed" />
  );
}

function fillAndAssign(title: string) {
  const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
  const by = (id: string) => dialog.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  fireEvent.change(by('vibe-assign-person'), { target: { value: HELPER_EMAIL } });
  fireEvent.blur(by('vibe-assign-person'));
  fireEvent.change(by('vibe-assign-title'), { target: { value: title } });
  fireEvent.click(by('vibe-assign-submit'));
  return { dialog, submit: () => fireEvent.click(by('vibe-assign-submit')) };
}

// Needs two instances on one hub; the live-backend CI job has one, so it never selects this.
describe.skipIf(!HELPER_EMAIL)('Ask for help never fails', () => {
  const signupInfo = getTestSignupInfo();
  const projectDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'asknf'));
  const { created: cleanupProjects } = trackCreatedRows(Project.type);

  beforeAll(async () => {
    const r = await fetch(`${HUB}/api/v1/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: HELPER_EMAIL, password: HELPER_PW }),
    });
    expect(r.ok, `helper login on ${HUB}`).toBe(true);
    const data = ((await r.json()) as { data: { api_key?: string; token?: string } }).data;
    helperToken = data.api_key ?? data.token ?? '';
  });

  beforeEach(async (ctx: { task: { name: string } }) => {
    await apiTestSetup(signupInfo, ctx.task.name);
    await cloudManager.refreshStatus();
    expect(dataContext.cloudLoginAvailable, 'needs a hub-logged-in backend (FLOW_INSTANCE=…)').toBe(true);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    cleanup();
    await helperSocket('connect');
  });
  afterAll(() => fs.rmSync(projectDir, { recursive: true, force: true }));

  // -------------------------------------------------------------------------
  // Ask someone for help (Vibe)
  // -------------------------------------------------------------------------

  describe.each(['before', 'after'])('the answer to Ask is lost %s the request was saved', (when) => {
    it('asking again delivers the ask exactly once', async () => {
      const title = `help lost ${when} ${Date.now()}`;
      const real = dataManager.callAction.bind(dataManager);
      let armed = true;
      vi.spyOn(dataManager, 'callAction').mockImplementation(async (info) => {
        if (armed && info.name === 'ask-for-help') {
          armed = false;
          if (when === 'after') await real(info); // the backend wrote it; the answer never came back
          throw new Error('injected: the answer did not come back');
        }
        return real(info);
      });
      const onAssigned = vi.fn();
      render(<AskHost onAssigned={onAssigned} />);
      const { dialog, submit } = fillAndAssign(title);

      // The person sees it failed and presses Ask again — the same request (same id).
      await waitFor(() => expect(dialog.textContent).toContain('injected'), { timeout: 10000 });
      submit();
      await waitFor(
        () =>
          expect(
            onAssigned,
            `asking again did not go through — the dialog says: ${dialog.textContent}`,
          ).toHaveBeenCalled(),
        { timeout: 10000 },
      );

      const got = await eventually(
        () => helperReceived(title),
        (cs) => cs.length > 0 && cs.every((c) => c.messages.length > 0),
      );
      expect(
        got.map((c) => c.messages.length),
        `the helper got ${got.length} conversation(s) for one ask, holding ${got.map((c) => c.messages.length)} message(s)`,
      ).toEqual([1]);
    });
  });

  it('the dialog cannot be closed while the request is saved, and says so once it is', async () => {
    const title = `closed early ${Date.now()}`;
    const told = vi.spyOn(notify, 'success');
    const real = dataManager.callAction.bind(dataManager);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    vi.spyOn(dataManager, 'callAction').mockImplementation(async (info) => {
      if (info.name === 'ask-for-help') await held;
      return real(info);
    });

    render(<AskHost onAssigned={() => {}} />);
    fillAndAssign(title);
    await waitFor(() => expect(document.querySelector('[data-testid="vibe-assign-submit"]')).toBeDisabled(), {
      timeout: 10000,
    });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await act(() => new Promise((r) => setTimeout(r, 200)));
    expect(
      document.querySelector('[data-testid="dialog-closed"]'),
      'closing mid-save would lose what was typed',
    ).toBeNull();

    await act(async () => {
      release();
    });
    await waitFor(() => expect(document.querySelector('[data-testid="dialog-closed"]')).not.toBeNull(), {
      timeout: 15000,
    });
    expect(told, 'the person must be told the ask went').toHaveBeenCalled();
  });

  it('a helper who was offline when asked finds the task on their board when they come back', async () => {
    const title = `while away ${Date.now()}`;
    await helperSocket('disconnect');
    const onAssigned = vi.fn();
    render(<AskHost onAssigned={onAssigned} />);
    fillAndAssign(title);
    await waitFor(() => expect(onAssigned).toHaveBeenCalled(), { timeout: 15000 });
    const taskId = onAssigned.mock.calls[0][0] as string;

    await helperSocket('connect');
    const onBoard = await eventually(
      async () => (await fetch(`${HELPER_API}/api/v1/graph/task/${taskId}`)).ok,
      (ok) => ok,
    );
    expect(onBoard, `task ${taskId.slice(0, 8)} never reached the helper's board after they reconnected`).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Help desk
  // -------------------------------------------------------------------------

  it('the help desk portal offers a person even when the desk ships a support agent', async () => {
    const project = new Project({ id: 'b0000000-0000-4000-8000-000000000001', name: 'Help Desk' });
    const { container } = render(<HelpdeskAsk project={project} />);
    expect(
      container.querySelector('[data-testid="support-agent-chat"]'),
      'precondition: the agent chat renders',
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="helpdesk-ask-button"]'),
      'the support agent tells users to "use Ask for help to reach a person" — there is no such button on the page',
    ).not.toBeNull();
  });

  it.each([
    ['the help desk files cannot be fetched', () => failOnce('helpdesk-ensure')],
    [
      'indexing the help desk fails',
      () => vi.spyOn(systemTools, 'fastScanProject').mockRejectedValue(new Error('injected: index failed')),
    ],
  ])(
    '%s → the user can still ask a person',
    async (_label, breakIt) => {
      breakIt();
      // Force the index step to run even on a warm checkout.
      vi.spyOn(systemTools, 'projectNeverIndexed').mockResolvedValue(true);
      const onNoPortal = vi.fn();
      const onClose = vi.fn();
      render(
        <MemoryRouter>
          <HelpdeskLoadDialog open onClose={onClose} onNoPortal={onNoPortal} />
        </MemoryRouter>,
      );

      await waitFor(
        () =>
          expect(
            document.querySelector('[data-testid="helpdesk-load-retry"]') ??
              (onNoPortal.mock.calls.length ? true : null),
          ).toBeTruthy(),
        { timeout: 60000 },
      );
      expect(
        onNoPortal,
        'loading the guides failed and the dialog offers only Retry — asking a person needs none of what failed',
      ).toHaveBeenCalled();
    },
    70000,
  );

  it('closing the sign-in window tells the user their question is saved and will send after sign-in', async () => {
    const warnings = vi.spyOn(notify, 'warning');
    // Signed out, as a first-time user is: the backend keeps the ask and says why it is waiting.
    dataContext.setCloudLoggedIn(false);
    onTestFinished(() => dataContext.setCloudLoggedIn(true));
    vi.spyOn(oauthService, 'connect').mockRejectedValue(new Error('Login was canceled.'));
    const real = dataManager.callAction.bind(dataManager);
    vi.spyOn(dataManager, 'callAction').mockImplementation(async (info) =>
      info.name === 'ask-for-help'
        ? {
            conversation_id: crypto.randomUUID(),
            task_id: null,
            message_id: crypto.randomUUID(),
            delivery: {
              header: 'created',
              body: null,
              failure: { kind: 'signed_out', message: "You're signed out — sign in to send this." },
            },
          }
        : real(info),
    );

    render(
      <MemoryRouter>
        <AskForHelpDialog open onOpenChange={() => {}} projectId={null} origin="footer" desk={{ kind: 'desk' }} />
      </MemoryRouter>,
    );
    fireEvent.change(document.querySelector('[data-testid="vibe-assign-title"]')!, {
      target: { value: 'my agent will not start' },
    });
    await waitFor(() => expect(document.querySelector('[data-testid="vibe-assign-submit"]')).toBeEnabled());
    fireEvent.click(document.querySelector('[data-testid="vibe-assign-submit"]')!);
    await waitFor(() => expect(oauthService.connect).toHaveBeenCalled());
    await waitFor(() => expect(warnings).toHaveBeenCalled());

    expect(String(warnings.mock.calls[0][0].title)).toMatch(/saved/i);
  });
});
