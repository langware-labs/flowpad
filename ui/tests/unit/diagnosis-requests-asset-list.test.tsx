/**
 * The Assets body for `diagnosis_request` lists the hub's requests (`mine`) — not the index —
 * and a row opens its request by typeid. A request has no file, so the index-backed list's
 * row click could only say "Asset has no file on disk".
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@src/i18n-init';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';

const ID = '6c401631-0c8a-4b0d-a9db-a89874b5758e';
const OTHER = '11111111-1111-4111-8111-111111111111';

vi.mock('@src/hooks/use-action', () => ({
  useAction: () => ({
    data: [
      { id: ID, title: 'Runs marked interrupted', run_count: 1, project_id: 'p-1' },
      { id: OTHER, name: 'Elsewhere', run_count: 0, project_id: 'p-2' },
    ],
    isLoading: false,
  }),
}));

import { DiagnosisRequestsAssetList } from '@src/components/assets/DiagnosisRequestsAssetList';
import { projectScope } from '@src/lib/scope-filter';
import type { DockPointer } from '@src/navigation/DockPointer';

describe('DiagnosisRequestsAssetList', () => {
  it("lists the scope's hub requests and opens one by its typeid", () => {
    const onOpen = vi.fn<(p: DockPointer) => void>();
    render(
      <I18nProvider i18n={i18n}>
        <DiagnosisRequestsAssetList scope={projectScope('p-1')} onOpen={onOpen} />
      </I18nProvider>,
    );

    expect(screen.getByText('Runs marked interrupted')).toBeTruthy();
    expect(screen.queryByText('Elsewhere')).toBeNull();

    fireEvent.click(screen.getByTestId(`diagnosis-request-row-${ID}`));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0].toUrl()).toContain(ID);
  });
});
