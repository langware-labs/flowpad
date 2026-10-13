/** One card body for every entity: name, kind, the type's own facts, path. */
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Conversation, Shell } from '@sdk';
import { EntityCard, EntityCardBody, UrlTabCard } from '@src/components/entity-card/EntityCard';
import { entityCardRows } from '@src/components/entity-card/entity-card-rows';

const entity = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@src/hooks/entity-hooks', () => ({ useEntity: () => ({ data: entity.current }) }));
vi.mock('@src/components/llm-endpoints/my-endpoints', () => ({ useMyEndpoint: () => ({ endpoint: null }) }));
vi.mock('@src/tabs/provider-meta', () => ({
  ProcessTabCard: ({ processId }: { processId: string }) => <div data-testid="process-card">{processId}</div>,
}));

afterEach(cleanup);

const ID = '3f2b8c1e-6a4d-4e2b-9c1a-5d7e8f901234';

describe('entity card', () => {
  it('a conversation shows its title, channel, message count and who it is with', () => {
    entity.current = new Conversation({
      title: 'New BUGS',
      channel: 'whatsapp',
      message_count: 12,
      address: ['+972500000000'],
    } as never);
    render(<EntityCard type={Conversation.type} id={ID} fallbackName="x" />);
    const card = screen.getByTestId('entity-card');
    expect(card).toHaveTextContent('New BUGS');
    expect(card).toHaveTextContent('Whatsapp');
    expect(card).toHaveTextContent('12');
    expect(card).toHaveTextContent('+972500000000');
  });

  it('a shell shows where it is working', () => {
    render(<EntityCardBody type={Shell.type} entity={{ displayName: 'zsh', workdir: '/work/app', status: 'running' }} />);
    expect(screen.getByTestId('entity-card-path')).toHaveTextContent('/work/app');
    expect(screen.getByTestId('entity-card')).toHaveTextContent('Running');
  });

  it('drops rows the entity has no value for, and falls back for an unknown type', () => {
    expect(entityCardRows('task', { status: 'to_do' })).toEqual([{ label: 'Status', value: 'New', copy: undefined }]);
    expect(entityCardRows('never_heard_of_it', {})).toHaveLength(0);
  });

  it('shows the name alone until the entity loads', () => {
    entity.current = null;
    render(<EntityCard type={Shell.type} id={ID} fallbackName="my shell" />);
    expect(screen.getByTestId('tab-tooltip-name')).toHaveTextContent('my shell');
    expect(screen.queryByTestId('entity-card')).toBeNull();
  });

  it('a session keeps its own card', () => {
    render(<EntityCard type="agentic_process" id={ID} fallbackName="x" />);
    expect(screen.getByTestId('process-card')).toHaveTextContent(ID);
  });

  it('a web page tab shows its address', () => {
    render(<UrlTabCard name="example.com" url="https://example.com/a" />);
    expect(screen.getByTestId('url-tab-card-url')).toHaveTextContent('https://example.com/a');
  });
});

describe('entity card rows', () => {
  it('a native conversation names the people on its roster when it has no channel address', () => {
    const rows = entityCardRows('conversation', { members: [{ name: 'Dana' }, { email: 'eli@example.com' }] });
    expect(rows.filter((r) => r.value === 'Dana' || r.value === 'eli@example.com')).toHaveLength(2);
  });
});
