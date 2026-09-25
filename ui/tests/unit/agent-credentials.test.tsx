/**
 * The agent's credentials, in its resources menu and nested in its editor: what its runs resolve —
 * the project's first, then the user's — read from the same status the Connections screen reads.
 * A row only navigates (URL-first); the nested page shows scope, store, state and each variable,
 * never a value.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CredentialStatusRow, CredentialsStatus } from '@sdk';

const nav = vi.hoisted(() => ({ openDock: vi.fn() }));
const creds = vi.hoisted(() => ({ status: null as unknown as CredentialsStatus, refresh: vi.fn(), remove: vi.fn() }));
const { AGENT_URL } = vi.hoisted(() => ({ AGENT_URL: '/dock/assets/editor/agent/typeid/agent-33333333-3333-4333-8333-333333333333' }));
vi.mock('@src/navigation/useDockNavigation', async () => {
  const { DockPointer } = await import('@src/navigation/DockPointer');
  const currentDock = DockPointer.fromUrl(AGENT_URL);
  return { useDockNavigation: () => ({ navigation: nav, currentDock }) };
});
vi.mock('@src/components/credentials/use-credentials', () => ({
  useCredentials: () => ({ status: creds.status, templates: [], ready: true, refresh: creds.refresh }),
}));
vi.mock('@src/components/credentials/CredentialDialog', () => ({
  CredentialDialog: ({ draft }: { draft: { mode: string } }) => <div data-testid="credential-dialog" data-mode={draft.mode} />,
}));
vi.mock('@src/components/connections-manager/add-connection-dialog', () => ({ AddConnectionDialog: () => null }));
vi.mock('@sdk', async (orig) => {
  const actual = await orig<typeof import('@sdk')>();
  return { ...actual, credentialsService: { remove: creds.remove }, dataContext: { project: { typeId: { id: 'p1' } } } };
});

import { AgentCredentialsSection } from '@src/components/agent-resources/AgentCredentialsSection';
import { CredentialChild } from '@src/components/assets/editor/agent-profile/CredentialChild';

function row(extra: Partial<CredentialStatusRow>): CredentialStatusRow {
  return {
    typeid: 'secret_pack-1', name: 'openai', title: 'OpenAI', description: '', icon_name: '', help_url: '', setup_wiki: '',
    setup: 'Create a key at platform.openai.com', scope: 'user', project_id: null, environment: 'development',
    value_store: 'env', default_value_store: 'env', environments: {}, lm_provider: '', state: 'connected',
    vars: [{ env_var: 'OPENAI_API_KEY', label: 'API key', hint: '', placeholder: '', pattern: '', help_url: '', secret: true, required: true, present: true, found_in: 'env', warning: null, shadowed_by: null }],
    ...extra,
  } as CredentialStatusRow;
}

function status(credentials: CredentialStatusRow[]): CredentialsStatus {
  return { project_id: 'p1', environment: 'development', environments: ['development'], vault_enabled: false, credentials, files: [] } as CredentialsStatus;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  nav.openDock.mockReset();
  creds.remove.mockReset();
});

describe('agent credentials', () => {
  it("lists the project's first, then the user's, each saying its scope and state", () => {
    creds.status = status([
      row({}),
      row({ typeid: 'secret_pack-2', name: 'stripe', title: 'Stripe', scope: 'project', project_id: 'p1', state: 'missing',
        vars: [{ ...row({}).vars[0], env_var: 'STRIPE_KEY', present: false, warning: 'missing' }] }),
    ]);
    render(<AgentCredentialsSection />);
    fireEvent.click(screen.getByTestId('navigator-section-credentials'));
    const rows = screen.getAllByTestId(/^agent-resource-credential-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['agent-resource-credential-project-stripe', 'agent-resource-credential-user-openai']);
    expect(rows[0]).toHaveTextContent('project · 1 missing');
    expect(rows[1]).toHaveTextContent('user · set');
  });

  it('a row opens the credential nested in the agent — it only navigates', () => {
    creds.status = status([row({})]);
    render(<AgentCredentialsSection />);
    fireEvent.click(screen.getByTestId('navigator-section-credentials'));
    fireEvent.click(screen.getByTestId('agent-resource-credential-user-openai'));
    expect(nav.openDock).toHaveBeenCalledTimes(1);
    expect(nav.openDock.mock.calls[0][0].child).toEqual({ section: 'credential', typeId: 'secret_pack-1' });
    expect(creds.remove).not.toHaveBeenCalled();
  });

  it('the nested page shows scope, where values live and each variable — set or missing', () => {
    creds.status = status([
      row({ scope: 'project', value_store: 'vault', state: 'partial', vars: [
        row({}).vars[0],
        { ...row({}).vars[0], env_var: 'OPENAI_ORG', label: 'Org', present: false, required: false },
      ] }),
    ]);
    render(<CredentialChild typeid="secret_pack-1" onGone={() => undefined} />);
    expect(screen.getByTestId('credential-child-scope')).toHaveTextContent('project');
    expect(screen.getByTestId('credential-child-store')).toHaveTextContent('the vault');
    expect(screen.getByTestId('credential-var-OPENAI_API_KEY')).toHaveTextContent('set');
    expect(screen.getByTestId('credential-var-OPENAI_ORG')).toHaveTextContent('optional · not set');
    expect(screen.getByText('Create a key at platform.openai.com')).toBeInTheDocument();
  });

  it('Set values opens the one credential form with a values draft', async () => {
    creds.status = status([row({})]);
    render(<CredentialChild typeid="secret_pack-1" onGone={() => undefined} />);
    await act(async () => fireEvent.click(screen.getByTestId('credential-child-set-values')));
    expect(screen.getByTestId('credential-dialog')).toHaveAttribute('data-mode', 'values');
  });

  it('a user credential the project overrides says so', () => {
    creds.status = status([row({ vars: [{ ...row({}).vars[0], shadowed_by: 'secret_pack-9' }] })]);
    render(<CredentialChild typeid="secret_pack-1" onGone={() => undefined} />);
    expect(screen.getByTestId('credential-child-state')).toHaveTextContent("overridden by the project's");
    expect(screen.getByTestId('credential-child-shadowed')).toBeInTheDocument();
  });

  it('a credential gone from the status says so', () => {
    creds.status = status([]);
    render(<CredentialChild typeid="secret_pack-404" onGone={() => undefined} />);
    expect(screen.getByTestId('credential-child-missing')).toBeInTheDocument();
  });
});
