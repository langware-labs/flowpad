/**
 * The Data Sources screen words a source that is not delivering from the SAME table the stream
 * inbox's attention strip reads (`ATTENTION`): the same sentence, the same next step, and Verify
 * offered exactly where the table says Verify recovers it.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@lingui/core';
import { fakeSource } from './fake-source';

vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@src/components/setup-wizard/SetupStagesButton', () => ({ SetupStagesButton: () => null }));
vi.mock('@src/components/data-sources/SourceMenu', () => ({ SourceMenu: () => null }));
vi.mock('@src/components/data-sources/ChannelRouteControl', () => ({ ChannelRouteControl: () => null }));

import { SourceActions, SourceSetupDetails } from '@src/components/data-sources/source-parts';
import { ATTENTION, type AttentionKind } from '@src/components/data-sources/source-attention';

const noop = () => {};
const fake = (fields: Parameters<typeof fakeSource>[2]) => fakeSource('s', 'gmail', fields);

describe('the Data Sources screen and the attention strip say the same thing', () => {
  afterEach(cleanup);

  it.each<[AttentionKind, Parameters<typeof fakeSource>[2], string]>([
    ['parked', { health: 'config_error', error_code: 'access_denied', error_detail: 'refused' }, 'access denied: refused'],
    ['held', { health: 'ok', error_code: 'write_back_held', error_detail: 'notes.md' }, 'notes.md'],
    ['unresolved', { status: 'new' }, i18n._(ATTENTION.unresolved.fallback)],
  ])('a %s source shows its reason and the table’s next step', (kind, fields, wrong) => {
    const source = fake(fields);
    render(<SourceSetupDetails source={source} />);
    const note = screen.getByTestId(`source-${kind}-${source.id}`);
    expect(note.textContent).toBe(wrong + i18n._(ATTENTION[kind].next));
  });

  it('a setup source shows its own note; a listening, paused or retrying one shows no note', () => {
    const owed = fake({ status: 'setup', setup_detail: 'Invite the bot.' });
    const { container, rerender } = render(<SourceSetupDetails source={owed} />);
    expect(container.textContent).toBe('Invite the bot.');
    for (const fields of [{}, { status: 'disabled' }, { health: 'transient_error' }]) {
      rerender(<SourceSetupDetails source={fake(fields)} />);
      expect(container.textContent).toBe('');
    }
  });

  it.each<[string, Parameters<typeof fakeSource>[2], boolean]>([
    ['setup', { status: 'setup' }, true],
    ['parked', { health: 'config_error' }, true],
    ['unresolved', { status: 'new' }, true],
    ['held', { health: 'ok', error_code: 'write_back_held' }, false],
    ['paused', { status: 'disabled' }, false],
    ['listening', {}, false],
  ])('Verify is offered for a %s source exactly when Verify is its verb', (_kind, fields, offered) => {
    const source = fake(fields);
    render(<SourceActions source={source} onEdit={noop} onReplay={noop} onDelete={noop} />);
    expect(screen.queryByTestId(`source-verify-${source.id}`) !== null).toBe(offered);
  });
});
