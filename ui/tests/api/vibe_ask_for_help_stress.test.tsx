/**
 * Stress: "Ask someone for help" with images, through the real dialog on a real hub-logged-in
 * backend. Every ask is recorded (title asked, task id, error, ms) to STRESS_OUT so the
 * recipient side can be checked against it.
 *
 * Run: FLOW_INSTANCE=<sender> ASK_TO=<recipient email> STRESS_OUT=<file> vitest --project api <this>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { dataContext, Project } from '@sdk';
import { cloudManager } from '@sdk/services/cloud_login';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VibeAssignTaskDialog } from '@src/pages/flow-page/VibeAssignTaskDialog';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const TO = process.env.ASK_TO ?? '';
const OUT = process.env.STRESS_OUT ?? '';

type Outcome = { scenario: string; title: string; to: string; files: { name: string; size: number }[]; taskId?: string; error?: string; ms: number };
const outcomes: Outcome[] = [];

function png(name: string, size: number): File {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < size; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(size, i + 65536)));
  return new File([bytes], name, { type: 'image/png' });
}

describe.skipIf(!TO || !OUT)('Ask someone for help — stress', () => {
  const signupInfo = getTestSignupInfo();
  const projectDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'askstress'));
  let projectId = '';

  beforeEach(async (ctx: { task: { name: string } }) => {
    await apiTestSetup(signupInfo, ctx.task.name);
    await cloudManager.refreshStatus();
    expect(dataContext.cloudLoginAvailable, 'needs a hub-logged-in backend').toBe(true);
    if (!projectId) projectId = (await new Project({ name: projectDir }).save([])).id;
  });
  afterEach(() => cleanup());
  afterAll(() => {
    if (OUT) fs.writeFileSync(OUT, JSON.stringify({ projectId, outcomes }, null, 2));
  });

  async function ask(scenario: string, title: string, files: File[], to = TO): Promise<Outcome> {
    const onAssigned = vi.fn();
    const { container, unmount } = render(
      <VibeAssignTaskDialog open onOpenChange={() => {}} projectId={projectId} sessionTypeId={null} onAssigned={onAssigned} />,
    );
    // Radix portals the dialog to body; scope to THIS dialog's content.
    const dialogs = container.ownerDocument.querySelectorAll('[role="dialog"]');
    const dialog = dialogs[dialogs.length - 1] as HTMLElement;
    const q = within(dialog);
    const person = q.getByTestId('vibe-assign-person');
    fireEvent.change(person, { target: { value: to } });
    fireEvent.blur(person);
    fireEvent.change(q.getByTestId('vibe-assign-title'), { target: { value: title } });
    if (files.length) {
      fireEvent.change(dialog.querySelector('input[type="file"]')!, { target: { files } });
      await waitFor(() => expect(q.getAllByText(files[files.length - 1].name).length).toBeGreaterThan(0));
    }
    const started = performance.now();
    fireEvent.click(q.getByTestId('vibe-assign-submit'));
    const errorRow = () => dialog.querySelector('p.border-destructive\\/60');
    await waitFor(() => expect(onAssigned.mock.calls.length > 0 || errorRow() !== null).toBe(true), { timeout: 15000 }); // the tier's own test cap; slower is a finding
    const outcome: Outcome = {
      scenario,
      title,
      to,
      files: files.map((f) => ({ name: f.name, size: f.size })),
      taskId: onAssigned.mock.calls[0]?.[0],
      error: errorRow()?.textContent ?? undefined,
      ms: Math.round(performance.now() - started),
    };
    outcomes.push(outcome);
    unmount();
    return outcome;
  }

  const stamp = Date.now();

  it('S1 one image', async () => {
    await ask('S1', `S1 one image ${stamp}`, [png('shot-1.png', 165_000)]);
  });
  it('S2 three images', async () => {
    await ask('S2', `S2 three images ${stamp}`, [png('a.png', 50_000), png('b.png', 120_000), png('c.png', 300_000)]);
  });
  it('S3 large image 8MB', async () => {
    await ask('S3', `S3 large ${stamp}`, [png('large.png', 8_000_000)]);
  });
  it('S4 unicode + spaces filename', async () => {
    await ask('S4', `S4 unicode ${stamp}`, [png('צילום מסך 2026-10-05 ב-10.38.png', 90_000)]);
  });
  it('S5 two files, same name', async () => {
    await ask('S5', `S5 same name ${stamp}`, [png('dup.png', 10_000), png('dup.png', 20_000)]);
  });
  it('S6 no image', async () => {
    await ask('S6', `S6 no image ${stamp}`, []);
  });
  it('S7 same title x5, sequential', async () => {
    for (let i = 0; i < 5; i++) await ask('S7', `S7 same title ${stamp}`, [png(`s7-${i}.png`, 40_000)]);
  });
  it('S8 same title x4, concurrent', async () => {
    await Promise.all([0, 1, 2, 3].map((i) => ask('S8', `S8 concurrent ${stamp}`, [png(`s8-${i}.png`, 40_000)])));
  });
  it('S9 ask yourself, with image', async () => {
    const me = (dataContext as unknown as { cloudUser?: { email?: string } }).cloudUser?.email ?? process.env.ASK_SELF ?? '';
    if (me) await ask('S9', `S9 self ${stamp}`, [png('self.png', 30_000)], me);
  });
});
