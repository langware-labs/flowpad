import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { SetupNodeResult, SetupTreeResult } from '@sdk';
import { SetupTreeView } from '@src/components/project-setup/SetupTreeView';

afterEach(cleanup);

const node = (id: string, state: SetupNodeResult['state'], over: Partial<SetupNodeResult> = {}): SetupNodeResult => ({
  id,
  label: id.toUpperCase(),
  level: 0,
  state,
  detail: '',
  prepare: null,
  run: null,
  children: [],
  shared: false,
  ...over,
});

const TREE: SetupTreeResult = {
  state: 'blocked',
  detail: 'Shop: waiting on WAHA',
  total: 4,
  done: 2,
  ran: true,
  root: node('project-p1', 'blocked', {
    detail: 'waiting on WAHA',
    children: [
      node('credential:waha', 'done'),
      node('data_source-w1', 'blocked', {
        detail: 'waiting on WAHA container',
        children: [node('asset_setup:waha-container', 'failed', { detail: 'Docker is not running' })],
      }),
      node('credential:waha', 'done', { shared: true }),
    ],
  }),
};

describe('SetupTreeView', () => {
  it('draws every node under what needs it, with its state and why it is not done', () => {
    render(<SetupTreeView tree={TREE} hideRoot />);

    expect(screen.getByTestId('setup-tree-progress').textContent).toContain('2 of 4 set up');
    expect(screen.queryByTestId('setup-node-project-p1')).toBeNull();
    const failed = screen.getByTestId('setup-node-asset_setup:waha-container');
    expect(failed.getAttribute('data-state')).toBe('failed');
    expect(failed.textContent).toContain('Docker is not running');
    expect(failed.className).toContain('border-red-500');
    expect(screen.getByTestId('setup-node-data_source-w1').textContent).toContain('waiting on WAHA container');
    // A done node keeps quiet: its detail is not news.
    expect(screen.getAllByTestId('setup-node-credential:waha')[0].getAttribute('data-state')).toBe('done');
  });

  it('a setup refused before anything ran says why', () => {
    render(<SetupTreeView tree={{ state: 'refused', detail: 'the setup tree has a cycle: a -> b -> a', root: null, total: 0, done: 0, ran: false }} />);
    expect(screen.getByTestId('setup-tree-refused').textContent).toBe('the setup tree has a cycle: a -> b -> a');
  });

  it('draws nothing before there is a tree', () => {
    const { container } = render(<SetupTreeView tree={null} />);
    expect(container.innerHTML).toBe('');
  });
});
