import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OwnerLoadGate } from '@src/components/project-setup/OwnerLoadGate';

const app = vi.hoisted(() => ({ value: { data: null as { project_id: string } | null, isLoading: false } }));
vi.mock('@sdk/react/hooks', () => ({ useEntity: () => app.value }));
vi.mock('@src/components/project-setup/ProjectLoadGate', () => ({
  ProjectLoadGate: ({ projectId }: { projectId: string }) => <p>loads {projectId}</p>,
}));

afterEach(cleanup);

const open = () =>
  render(<OwnerLoadGate urlProject="old-project" appId="app-1" display=""><p>app</p></OwnerLoadGate>);

it('loads the project that owns the app now, not the one the link was made under', () => {
  app.value = { data: { project_id: 'new-project' }, isLoading: false };
  open();
  expect(screen.getByText('loads new-project')).toBeInTheDocument();
});

it('falls back to the linked project when the app is not known here', () => {
  app.value = { data: null, isLoading: false };
  open();
  expect(screen.getByText('loads old-project')).toBeInTheDocument();
});

it('decides nothing until the app has been looked up', () => {
  app.value = { data: null, isLoading: true };
  const { container } = open();
  expect(container).toBeEmptyDOMElement();
});
