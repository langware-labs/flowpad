import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@lingui/react';
import { i18n } from '@lingui/core';
import { deploymentState, issueState } from '@src/components/items/item-state';
import { canDo, roleOf } from '@src/components/items/role';
import { ItemCard } from '@src/components/items/ItemCard';

i18n.loadAndActivate({ locale: 'en', messages: {} });

describe('item state', () => {
  it('reads a planned deployment as starting, never live', () => {
    expect(deploymentState('planned')).toBe('starting');
    expect(deploymentState('running')).toBe('running');
    expect(deploymentState('paused')).toBe('paused');
    expect(deploymentState(undefined)).toBe('off');
  });
  it('reads issues as open error, attention or resolved', () => {
    expect(issueState('open', 'error')).toBe('error');
    expect(issueState('open', 'warning')).toBe('attention');
    expect(issueState('resolved', 'error')).toBe('resolved');
  });
});

describe('role', () => {
  it('takes the strongest role and stays silent when not expanded', () => {
    expect(roleOf({ expand: { roles: ['reader', 'owner'] } })).toBe('owner');
    expect(roleOf({ expand: { roles: ['admin'] } })).toBe('admin');
    expect(roleOf({ expand: { roles: ['runner'] } })).toBe('reader');
    expect(roleOf({ expand: { roles: null } })).toBeUndefined();
  });
  it('answers actions plain or type-qualified, undefined when not expanded', () => {
    const e = { expand: { allowed_actions: ['agent.deploy', 'read'] }, getType: () => 'agent' };
    expect(canDo(e, 'deploy')).toBe(true);
    expect(canDo(e, 'delete')).toBe(false);
    expect(canDo({}, 'deploy')).toBeUndefined();
  });
});

describe('ItemCard', () => {
  it('shows state, role and only the actions the person may run', () => {
    const onOpen = vi.fn();
    render(
      <I18nProvider i18n={i18n}>
        <ItemCard
          onOpen={onOpen}
          card={{
            title: 'hello agent',
            state: 'running',
            role: 'reader',
            at: { date: new Date(Date.now() - 3 * 3600_000) },
            actions: [
              { key: 'chat', label: 'Chat', onSelect: () => {} },
              { key: 'deploy', label: 'Deploy', onSelect: () => {}, allowed: false },
            ],
          }}
        />
      </I18nProvider>,
    );
    expect(screen.getByTestId('item-state').dataset.state).toBe('running');
    expect(screen.getByTestId('item-role').dataset.role).toBe('reader');
    expect(screen.getByTestId('item-time').textContent).toBe('Updated 3h ago');
    expect(screen.queryByTestId('item-action-chat')).not.toBeNull();
    expect(screen.queryByTestId('item-action-deploy')).toBeNull();
    screen.getByTestId('item-action-chat').click();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
