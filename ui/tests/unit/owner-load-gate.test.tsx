import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OwnerLoadGate } from '@src/components/project-setup/OwnerLoadGate';

const app = vi.hoisted(() => ({ value: { data: null as { project_id: string } | null, isLoading: false } }));
vi.mock('@sdk/react/hooks', () => ({ useEntity: () => app.value }));
const served = vi.hoisted(() => ({ value: { webappId: null as string | null, loading: false } }));
vi.mock('@src/hooks/flow-hooks/useAppDisplay', () => ({
  useAppWebappId: (artifactId: string | null, microAppId: string | null) =>
    microAppId ? { webappId: microAppId, loading: false } : artifactId ? served.value : { webappId: null, loading: false },
}));
vi.mock('@src/components/project-setup/ProjectLoadGate', () => ({
  ProjectLoadGate: ({ projectId, asset }: { projectId: string; asset: string }) => (
    <p>loads {projectId} for {asset || 'the project'}</p>
  ),
}));

afterEach(cleanup);

const open = () =>
  render(<OwnerLoadGate urlProject="old-project" appId="app-1" display=""><p>app</p></OwnerLoadGate>);

it('loads the project that owns the app now, not the one the link was made under', () => {
  app.value = { data: { project_id: 'new-project' }, isLoading: false };
  open();
  expect(screen.getByText(/loads new-project/)).toBeInTheDocument();
});

it('falls back to the linked project when the app is not known here', () => {
  app.value = { data: null, isLoading: false };
  open();
  expect(screen.getByText(/loads old-project/)).toBeInTheDocument();
});

it('decides nothing until the app has been looked up', () => {
  app.value = { data: null, isLoading: true };
  const { container } = open();
  expect(container).toBeEmptyDOMElement();
});

const openArtifact = () =>
  render(<OwnerLoadGate urlProject="p" appId={null} artifactId="art-1" display=""><p>app</p></OwnerLoadGate>);

it('scopes an artifact-addressed app to the webapp serving it, not the whole project', () => {
  app.value = { data: { project_id: 'p' }, isLoading: false };
  served.value = { webappId: '11111111-1111-4111-8111-111111111111', loading: false };
  openArtifact();
  expect(screen.getByText('loads p for micro_app-11111111-1111-4111-8111-111111111111')).toBeInTheDocument();
});

it('waits for the artifact\'s routes before choosing what to load', () => {
  served.value = { webappId: null, loading: true };
  const { container } = openArtifact();
  expect(container).toBeEmptyDOMElement();
});
