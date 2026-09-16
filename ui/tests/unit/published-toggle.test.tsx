import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PublishedToggle } from '@src/components/assets/editor/PublishedToggle';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_PROJECT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MOUNT = '/Users/me/Flowpad workspace/proj';

const mocks = vi.hoisted(() => ({
  project: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } as { id: string } | null,
  hubOnly: false,
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    dataContext: {
      ...actual.dataContext,
      get project() {
        return mocks.project;
      },
    },
  };
});

vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => mocks.hubOnly }));
vi.mock('@src/notifications', () => ({ notify: { success: mocks.success, error: mocks.error } }));

function entity(overrides: Partial<{ type: string; published: boolean; asset_ref: string; project_id: string; scope: string }> = {}) {
  const e = {
    typeId: { type: overrides.type ?? 'skill', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    name: 'rca',
    published: overrides.published ?? false,
    asset_ref: overrides.asset_ref ?? `${MOUNT}/.claude/skills/rca`,
    project_id: overrides.project_id ?? PROJECT_ID,
    scope: overrides.scope ?? 'project',
    setPublished: vi.fn(),
  };
  // The real ``APIEntity.setPublished`` adopts the backend's canonical row,
  // which is what flips ``published`` — the toggle never writes the field.
  e.setPublished.mockImplementation((next: boolean) => {
    e.published = next;
    return Promise.resolve(e);
  });
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hubOnly = false;
  mocks.project = { id: PROJECT_ID };
});
afterEach(cleanup);

describe('PublishedToggle', () => {
  it('publishes through the entity action and reflects the adopted row', async () => {
    const e = entity();
    const onChanged = vi.fn();
    const { rerender } = render(<PublishedToggle entity={e as any} onChanged={onChanged} />);
    expect(screen.getByTestId('published-toggle')).toHaveAttribute('data-state', 'unpublished');

    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(e.setPublished).toHaveBeenCalledWith(true, PROJECT_ID));
    expect(onChanged).toHaveBeenCalledWith(e);
    expect(mocks.success).toHaveBeenCalled();
    // The prop-passed entity was mutated by the (mocked) adoption; a re-render shows it.
    rerender(<PublishedToggle entity={e as any} onChanged={onChanged} />);
    expect(screen.getByTestId('published-toggle')).toHaveAttribute('data-state', 'published');
    expect(screen.getByRole('button', { name: 'Published' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('unpublishes a published asset', async () => {
    const e = entity({ published: true });
    render(<PublishedToggle entity={e as any} />);
    await userEvent.click(screen.getByRole('button', { name: 'Published' }));
    await waitFor(() => expect(e.setPublished).toHaveBeenCalledWith(false, PROJECT_ID));
  });

  it('shows the backend refusal and leaves the state alone', async () => {
    const e = entity();
    e.setPublished.mockRejectedValue(new Error('only assets inside the project folder can be published'));
    render(<PublishedToggle entity={e as any} />);
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(mocks.error.mock.calls[0][0].message).toMatch(/inside the project folder/);
    expect(screen.getByTestId('published-toggle')).toHaveAttribute('data-state', 'unpublished');
  });

  it('renders nothing on the hub runtime', () => {
    mocks.hubOnly = true;
    render(<PublishedToggle entity={entity() as any} />);
    expect(screen.queryByTestId('published-toggle')).not.toBeInTheDocument();
  });

  it('renders nothing for a type that cannot be published', () => {
    render(<PublishedToggle entity={entity({ type: 'task' }) as any} />);
    expect(screen.queryByTestId('published-toggle')).not.toBeInTheDocument();
  });

  it('renders nothing for an asset another project owns', () => {
    render(<PublishedToggle entity={entity({ project_id: OTHER_PROJECT_ID }) as any} />);
    expect(screen.queryByTestId('published-toggle')).not.toBeInTheDocument();
  });

  it('renders nothing for a system asset', () => {
    render(<PublishedToggle entity={entity({ scope: 'system' }) as any} />);
    expect(screen.queryByTestId('published-toggle')).not.toBeInTheDocument();
  });

  it('carries an info glyph that explains what Published does', async () => {
    render(<PublishedToggle entity={entity() as any} />);
    await userEvent.click(screen.getByTestId('published-info'));
    const text = document.body.textContent ?? '';
    expect(text).toContain('project_manifest.json');
    expect(text).toContain('flow asset install');
  });
});
