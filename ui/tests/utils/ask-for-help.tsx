/**
 * Shared drivers for api-tier tests of "Ask someone for help" and support tickets: a backend
 * logged in to a hub, and the real dialog driven the way a person does it.
 */
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { dataContext } from '@sdk';
import { cloudManager } from '@sdk/services/cloud_login';
import { expect, vi } from 'vitest';
import { AskForHelpDialog } from '@src/components/help/AskForHelpDialog';
import { apiTestSetup } from './test-utils';

/** `apiTestSetup`, plus the hub login the app's boot reads (main.ts → cloudManager) and the
 *  tier's setup does not. Fails fast when the backend is not logged in to a hub. */
export async function hubLoggedInSetup(signupInfo: unknown, testName: string): Promise<void> {
  await apiTestSetup(signupInfo, testName);
  await cloudManager.refreshStatus();
  expect(dataContext.cloudLoginAvailable, 'needs a hub-logged-in backend (FLOW_INSTANCE=…)').toBe(true);
}

/** A PNG-signed file of `size` bytes. */
export function png(name: string, size: number): File {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new File([bytes], name, { type: 'image/png' });
}

export interface AskOutcome {
  taskId?: string;
  conversationId?: string;
  error?: string;
  ms: number;
}

/** One ask through the real dialog: person, title, files, Ask — until it is saved or shows its
 *  error row. Scoped to its own dialog, so several can run at once. */
export async function askForHelp(opts: {
  projectId: string | null;
  to: string;
  title: string;
  files?: File[];
}): Promise<AskOutcome> {
  const onAsked = vi.fn();
  const { container, unmount } = render(
    <AskForHelpDialog open onOpenChange={() => {}} projectId={opts.projectId} origin="vibe" onAsked={onAsked} />,
  );
  // Radix portals the dialog to body: the newest one is this render's.
  const dialogs = container.ownerDocument.querySelectorAll('[role="dialog"]');
  const dialog = dialogs[dialogs.length - 1] as HTMLElement;
  const q = within(dialog);
  const person = q.getByTestId('vibe-assign-person');
  fireEvent.change(person, { target: { value: opts.to } });
  fireEvent.blur(person);
  fireEvent.change(q.getByTestId('vibe-assign-title'), { target: { value: opts.title } });
  const files = opts.files ?? [];
  if (files.length) {
    fireEvent.change(dialog.querySelector('input[type="file"]')!, { target: { files } });
    await waitFor(() => expect(q.getAllByText(files[files.length - 1].name).length).toBeGreaterThan(0));
  }

  const started = performance.now();
  fireEvent.click(q.getByTestId('vibe-assign-submit'));
  const errorRow = () => dialog.querySelector('p.border-destructive\\/60');
  // The tier's own test cap; an ask that takes longer is a finding.
  await waitFor(() => expect(onAsked.mock.calls.length > 0 || errorRow() !== null).toBe(true), {
    timeout: 15000,
  });
  const asked = onAsked.mock.calls[0]?.[0] as { task_id?: string; conversation_id?: string } | undefined;
  const outcome: AskOutcome = {
    taskId: asked?.task_id ?? undefined,
    conversationId: asked?.conversation_id,
    error: errorRow()?.textContent ?? undefined,
    ms: Math.round(performance.now() - started),
  };
  unmount();
  return outcome;
}
