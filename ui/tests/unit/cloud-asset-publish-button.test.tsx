import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CloudAssetPublishButton } from '@src/components/entity-actions/CloudAssetPublishButton';

const mocks = vi.hoisted(() => ({
  entity: { remote: false, share: vi.fn() },
  typeInfo: { cloud_file_transport: 'git' as 'git' | 'embedded' },
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    dataManager: { ...actual.dataManager, getTypeInfo: () => mocks.typeInfo },
  };
});

vi.mock('@sdk/react/hooks', () => ({
  useEntity: () => ({ data: mocks.entity }),
}));

vi.mock('@src/notifications', () => ({
  notify: { success: mocks.success, error: mocks.error },
}));

const typeId = { type: 'agent', id: '004f3ab7-d33b-48c0-ae0e-6e61e181a343' } as any;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.entity.remote = false;
  mocks.typeInfo.cloud_file_transport = 'git';
  // The real ``APIEntity.share`` adopts the backend's canonical entity, which is
  // what flips ``remote`` — the button never writes that field itself.
  mocks.entity.share.mockImplementation(async () => {
    mocks.entity.remote = true;
    return mocks.entity;
  });
});

afterEach(cleanup);

describe('CloudAssetPublishButton', () => {
  it('publishes a Git-backed asset through the standard entity Share action', async () => {
    render(<CloudAssetPublishButton typeId={typeId} variant="compact" />);

    await userEvent.click(screen.getByRole('button', { name: 'Publish to cloud' }));

    await waitFor(() => expect(mocks.entity.share).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('asset-cloud-publish')).toHaveAttribute('data-state', 'published');
    expect(mocks.success).toHaveBeenCalled();
  });

  it('stays hidden for embedded types', () => {
    mocks.typeInfo.cloud_file_transport = 'embedded';
    render(<CloudAssetPublishButton typeId={typeId} variant="compact" />);

    expect(screen.queryByTestId('asset-cloud-publish')).not.toBeInTheDocument();
  });

  it('reports a publish rejection and remains local', async () => {
    mocks.entity.share.mockRejectedValue(new Error('project_not_published'));
    render(<CloudAssetPublishButton typeId={typeId} variant="compact" />);

    await userEvent.click(screen.getByRole('button', { name: 'Publish to cloud' }));

    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(screen.getByTestId('asset-cloud-publish')).toHaveAttribute('data-state', 'local');
  });
});
