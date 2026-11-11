/**
 * A received copy the receiver already has (an earlier share of the same skill): Install answers
 * 409 `asset_conflict`. The review dialog says so and offers Replace it, which repeats the SAME
 * install with `overwrite` — instead of a bare "Install failed" toast and no way forward.
 *
 * The boundary stood in for is `MessageAttachment.install` (the HTTP call); the dialog is real.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageAttachment } from '@sdk';

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
  useCurrentDock: () => null,
  useIsHomeSurface: () => false,
}));
vi.mock('@src/components/conversation/asset-review/useRunReceivedSkill', () => ({
  useRunSkillWithProjectPrompt: () => ({ start: vi.fn(), picker: null }),
}));

const { AssetReviewDialog } = await import('@src/components/conversation/asset-review/AssetReviewDialog');

afterEach(cleanup);

it('an install you already have asks to Replace it, and Replace repeats the install with overwrite', async () => {
  const ma = new MessageAttachment({
    id: '44444444-4444-4444-8444-444444444444',
    asset_type: 'skill',
    asset_id: '55555555-5555-4555-8555-555555555555',
    name: 'skill-plain',
    transfer_mode: 'copy',
    user_scope_allowed: true,
  } as Partial<MessageAttachment>);
  const calls: { scope: string; overwrite?: boolean }[] = [];
  vi.spyOn(MessageAttachment.prototype, 'install').mockImplementation(async (scope, _pid, opts = {}) => {
    calls.push({ scope, overwrite: opts.overwrite });
    if (!opts.overwrite) {
      throw Object.assign(new Error('409'), {
        response: { status: 409, data: { data: { asset_conflict: true } } },
      });
    }
    return null;
  });

  render(
    <MemoryRouter>
      <AssetReviewDialog
        open
        onClose={() => {}}
        attachments={[ma]}
        initialAttachmentId={ma.id!}
        attachmentProjectId={null}
      />
    </MemoryRouter>,
  );

  fireEvent.click(await screen.findByTestId('asset-install-global'));
  expect(await screen.findByTestId('asset-replace')).toHaveTextContent('You already have this');
  fireEvent.click(screen.getByTestId('asset-replace-confirm'));
  await waitFor(() =>
    expect(calls).toEqual([
      { scope: 'user', overwrite: false },
      { scope: 'user', overwrite: true },
    ]),
  );
  await waitFor(() => expect(screen.queryByTestId('asset-replace')).not.toBeInTheDocument());
});
