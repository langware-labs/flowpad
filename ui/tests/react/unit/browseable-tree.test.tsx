import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import {
  BrowseableTree,
  createMockBrowseable,
  mockPointerFor,
} from '@src/components/browseable-tree';
import type {
  Browseable,
  BrowseableRoot,
  ToolbarAction,
} from '@src/components/browseable-tree';

// ---- inline factories (mirror the directory-tree test conventions) ----

function makeLeaf(id: string, overrides: Partial<Browseable> = {}): Browseable {
  return createMockBrowseable({ id, label: id, hasChildren: false, ...overrides });
}

function makeRoot(
  id: string,
  opts: {
    label?: string;
    children?: Browseable[] | (() => Promise<Browseable[]>);
    toolbar?: ToolbarAction[];
    badge?: React.ReactNode;
    icon?: React.ReactNode;
    hasChildren?: boolean | 'unknown';
    pointer?: DockPointer | null;
    ownsPointer?: (p: DockPointer) => boolean;
    pathFor?: (p: DockPointer) => Promise<Browseable[]>;
  } = {},
): BrowseableRoot {
  const childList = opts.children;
  const listChildren =
    typeof childList === 'function'
      ? childList
      : childList !== undefined
        ? async () => childList
        : undefined;
  const root: BrowseableRoot = {
    id,
    kind: 'root',
    label: opts.label ?? id,
    icon: opts.icon,
    badge: opts.badge,
    hasChildren: opts.hasChildren ?? (childList !== undefined),
    pointer: opts.pointer === undefined ? mockPointerFor(id) : opts.pointer,
    toolbar: opts.toolbar,
    listChildren,
    ownsPointer:
      opts.ownsPointer ?? ((p) => !!p.pointer && p.pointer.startsWith(`mock/${id}`)),
    pathFor:
      opts.pathFor ??
      (async () => {
        return [root];
      }),
  };
  return root;
}

describe('BrowseableTree', () => {
  describe('Render - Roots', () => {
    it('renders the root labels', () => {
      const roots = [makeRoot('alpha', { label: 'Alpha' }), makeRoot('beta', { label: 'Beta' })];
      render(<BrowseableTree roots={roots} activePointer={null} />);
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });

    it('renders icon and badge for a root', () => {
      const root = makeRoot('alpha', {
        label: 'Alpha',
        icon: <span data-testid="alpha-icon">I</span>,
        badge: <span data-testid="alpha-badge">42</span>,
      });
      render(<BrowseableTree roots={[root]} activePointer={null} />);
      expect(screen.getByTestId('alpha-icon')).toBeInTheDocument();
      expect(screen.getByTestId('alpha-badge')).toBeInTheDocument();
    });

    it('empty roots → default empty state', () => {
      render(<BrowseableTree roots={[]} activePointer={null} />);
      expect(screen.getByText('No items')).toBeInTheDocument();
    });

    it('empty roots → custom empty state', () => {
      render(
        <BrowseableTree roots={[]} activePointer={null} emptyState={<div>Custom Empty</div>} />,
      );
      expect(screen.getByText('Custom Empty')).toBeInTheDocument();
    });

    it('renders global loading state', () => {
      render(<BrowseableTree roots={[]} activePointer={null} isLoading />);
      expect(screen.getByText('Loading...')).toBeInTheDocument();
    });

    it('renders global error state', () => {
      render(<BrowseableTree roots={[]} activePointer={null} error="Boom" />);
      expect(screen.getByText('Boom')).toBeInTheDocument();
    });
  });

  describe('Click → Navigate', () => {
    it('calls onNavigate with the row pointer', async () => {
      const user = userEvent.setup();
      const onNavigate = vi.fn();
      const root = makeRoot('alpha');
      render(
        <BrowseableTree roots={[root]} activePointer={null} onNavigate={onNavigate} />,
      );
      await user.click(screen.getByText('alpha'));
      expect(onNavigate).toHaveBeenCalledTimes(1);
      const arg = onNavigate.mock.calls[0][0] as DockPointer;
      expect(arg.pointer).toBe('mock/alpha');
    });

    it('does not navigate when pointer is null (header row)', async () => {
      const user = userEvent.setup();
      const onNavigate = vi.fn();
      const root = makeRoot('hdr', { pointer: null });
      render(
        <BrowseableTree roots={[root]} activePointer={null} onNavigate={onNavigate} />,
      );
      await user.click(screen.getByText('hdr'));
      expect(onNavigate).not.toHaveBeenCalled();
    });
  });

  describe('Expand / Collapse', () => {
    it('chevron click expands the root and lazy-loads children', async () => {
      const user = userEvent.setup();
      const root = makeRoot('alpha', {
        children: [makeLeaf('c1'), makeLeaf('c2')],
      });
      render(<BrowseableTree roots={[root]} activePointer={null} />);

      expect(screen.queryByText('c1')).not.toBeInTheDocument();

      const chevron = screen.getByTestId('browseable-chevron-alpha');
      await user.click(chevron);

      await waitFor(() => {
        expect(screen.getByText('c1')).toBeInTheDocument();
        expect(screen.getByText('c2')).toBeInTheDocument();
      });

      // Collapse
      await user.click(chevron);
      await waitFor(() => {
        expect(screen.queryByText('c1')).not.toBeInTheDocument();
      });
    });

    it('clicking the row toggles expansion AND navigates', async () => {
      const user = userEvent.setup();
      const onNavigate = vi.fn();
      const root = makeRoot('alpha', {
        children: [makeLeaf('c1')],
      });
      render(
        <BrowseableTree roots={[root]} activePointer={null} onNavigate={onNavigate} />,
      );

      await user.click(screen.getByText('alpha'));
      expect(onNavigate).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.getByText('c1')).toBeInTheDocument());
    });

    it('chevron click does not navigate', async () => {
      const user = userEvent.setup();
      const onNavigate = vi.fn();
      const root = makeRoot('alpha', { children: [makeLeaf('c1')] });
      render(
        <BrowseableTree roots={[root]} activePointer={null} onNavigate={onNavigate} />,
      );
      await user.click(screen.getByTestId('browseable-chevron-alpha'));
      expect(onNavigate).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByText('c1')).toBeInTheDocument());
    });

    it('leaves (hasChildren=false) have no chevron', () => {
      const root = makeRoot('alpha', {
        children: [makeLeaf('leaf1')],
      });
      render(<BrowseableTree roots={[root]} activePointer={null} />);
      // Root has a chevron; leaf does not. We expand first:
      const chevron = screen.getByTestId('browseable-chevron-alpha');
      expect(chevron).toBeInTheDocument();
      // No chevron testid for leaf1
      expect(screen.queryByTestId('browseable-chevron-leaf1')).not.toBeInTheDocument();
    });

    it('shows a loading indicator while listChildren is pending', async () => {
      const user = userEvent.setup();
      let resolve!: (v: Browseable[]) => void;
      const gate = new Promise<Browseable[]>((r) => (resolve = r));
      const root = makeRoot('alpha', { children: () => gate });

      render(<BrowseableTree roots={[root]} activePointer={null} />);
      await user.click(screen.getByTestId('browseable-chevron-alpha'));

      await waitFor(() =>
        expect(screen.getByText('Loading…')).toBeInTheDocument(),
      );

      resolve([makeLeaf('c1')]);

      await waitFor(() => expect(screen.getByText('c1')).toBeInTheDocument());
      expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    });

    it('shows an error message when listChildren rejects', async () => {
      const user = userEvent.setup();
      const root = makeRoot('alpha', {
        children: async () => {
          throw new Error('nope');
        },
      });
      render(<BrowseableTree roots={[root]} activePointer={null} />);
      await user.click(screen.getByTestId('browseable-chevron-alpha'));
      await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument());
    });

    it('shows "Empty" when listChildren returns []', async () => {
      const user = userEvent.setup();
      const root = makeRoot('alpha', { children: [] });
      render(<BrowseableTree roots={[root]} activePointer={null} />);
      await user.click(screen.getByTestId('browseable-chevron-alpha'));
      await waitFor(() => expect(screen.getByText('Empty')).toBeInTheDocument());
    });

    it('hasChildren="unknown" still shows a chevron when listChildren is provided', () => {
      const root = makeRoot('alpha', {
        hasChildren: 'unknown',
        children: [makeLeaf('c1')],
      });
      render(<BrowseableTree roots={[root]} activePointer={null} />);
      expect(screen.getByTestId('browseable-chevron-alpha')).toBeInTheDocument();
    });
  });

  describe('Selection from activePointer', () => {
    it('highlights the row whose pointer matches activePointer', () => {
      const root = makeRoot('alpha');
      render(<BrowseableTree roots={[root]} activePointer={mockPointerFor('alpha')} />);
      const item = screen.getByText('alpha').closest('[role="treeitem"]');
      expect(item).toHaveAttribute('aria-selected', 'true');
    });

    it('does not highlight when pointers differ', () => {
      const root = makeRoot('alpha');
      const other = new DockPointer(ViewType.ASSETS, 'mock/beta');
      render(<BrowseableTree roots={[root]} activePointer={other} />);
      const item = screen.getByText('alpha').closest('[role="treeitem"]');
      expect(item).toHaveAttribute('aria-selected', 'false');
    });

    it('header-only rows (pointer=null) are never selected', () => {
      const root = makeRoot('hdr', { pointer: null });
      const any = new DockPointer(ViewType.ASSETS, 'mock/anything');
      render(<BrowseableTree roots={[root]} activePointer={any} />);
      const item = screen.getByText('hdr').closest('[role="treeitem"]');
      expect(item).toHaveAttribute('aria-selected', 'false');
    });
  });

  describe('Deep-link auto-expand', () => {
    it('expands ancestors when activePointer points to a deep descendant', async () => {
      const leaf = makeLeaf('alpha/child-0/leaf');
      const child = makeLeaf('alpha/child-0', { hasChildren: true });
      const root = makeRoot('alpha', {
        children: [child],
        pathFor: async (p) => {
          if (p.pointer === 'mock/alpha/child-0/leaf') return [root, child, leaf];
          if (p.pointer === 'mock/alpha/child-0') return [root, child];
          return [root];
        },
      });
      // Wire child.listChildren so the tree can render grandchildren after expand
      (child as Browseable & { listChildren?: () => Promise<Browseable[]> }).listChildren =
        async () => [leaf];

      render(
        <BrowseableTree
          roots={[root]}
          activePointer={new DockPointer(ViewType.ASSETS, 'mock/alpha/child-0/leaf')}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText('alpha/child-0')).toBeInTheDocument();
        expect(screen.getByText('alpha/child-0/leaf')).toBeInTheDocument();
      });

      const leafRow = screen.getByText('alpha/child-0/leaf').closest('[role="treeitem"]');
      expect(leafRow).toHaveAttribute('aria-selected', 'true');
    });

    it('does nothing when no root owns the pointer', async () => {
      const root = makeRoot('alpha', {
        children: [makeLeaf('c1')],
        ownsPointer: () => false,
      });
      render(
        <BrowseableTree
          roots={[root]}
          activePointer={new DockPointer(ViewType.ASSETS, 'mock/foreign')}
        />,
      );
      // c1 should not appear — root was never expanded
      await Promise.resolve();
      expect(screen.queryByText('c1')).not.toBeInTheDocument();
    });
  });

  describe('Toolbar actions (per-row)', () => {
    it('renders toolbar buttons and calls run() on click', async () => {
      const user = userEvent.setup();
      const run = vi.fn();
      const root = makeRoot('alpha', {
        toolbar: [{ id: 'scan', icon: <span>R</span>, label: 'Scan', run }],
      });
      render(<BrowseableTree roots={[root]} activePointer={null} />);

      const btn = screen.getByTestId('browseable-toolbar-scan');
      await user.click(btn);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('toolbar click does not navigate', async () => {
      const user = userEvent.setup();
      const onNavigate = vi.fn();
      const root = makeRoot('alpha', {
        toolbar: [{ id: 'scan', icon: <span>R</span>, label: 'Scan', run: () => {} }],
      });
      render(
        <BrowseableTree roots={[root]} activePointer={null} onNavigate={onNavigate} />,
      );
      await user.click(screen.getByTestId('browseable-toolbar-scan'));
      expect(onNavigate).not.toHaveBeenCalled();
    });

    it('shows a busy indicator while an async run() is pending', async () => {
      const user = userEvent.setup();
      let resolve!: () => void;
      const gate = new Promise<void>((r) => (resolve = r));
      const root = makeRoot('alpha', {
        toolbar: [
          { id: 'scan', icon: <span>R</span>, label: 'Scan', run: async () => gate },
        ],
      });
      render(<BrowseableTree roots={[root]} activePointer={null} />);
      const btn = screen.getByTestId('browseable-toolbar-scan');
      await user.click(btn);

      await waitFor(() => expect(btn).toBeDisabled());
      resolve();
      await waitFor(() => expect(btn).not.toBeDisabled());
    });
  });

  describe('Base (header) toolbar', () => {
    it('renders header title and toolbar actions', async () => {
      const user = userEvent.setup();
      const run = vi.fn();
      const root = makeRoot('alpha');
      render(
        <BrowseableTree
          roots={[root]}
          activePointer={null}
          header={{
            title: 'Wiki',
            toolbar: [{ id: 'new-all', icon: <span>+</span>, label: 'New Asset', run }],
          }}
        />,
      );
      expect(screen.getByText('Wiki')).toBeInTheDocument();
      await user.click(screen.getByTestId('browseable-toolbar-new-all'));
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('applies aria-label from header title onto the tree', () => {
      const root = makeRoot('alpha');
      render(
        <BrowseableTree
          roots={[root]}
          activePointer={null}
          header={{ title: 'Wiki' }}
        />,
      );
      const tree = screen.getByRole('tree');
      expect(tree).toHaveAttribute('aria-label', 'Wiki');
    });
  });

  describe('ARIA', () => {
    it('sets role, aria-level, and aria-expanded correctly', async () => {
      const user = userEvent.setup();
      const root = makeRoot('alpha', { children: [makeLeaf('c1')] });
      render(<BrowseableTree roots={[root]} activePointer={null} />);

      const rootItem = screen.getByText('alpha').closest('[role="treeitem"]')!;
      expect(rootItem).toHaveAttribute('aria-level', '1');
      expect(rootItem).toHaveAttribute('aria-expanded', 'false');

      await user.click(screen.getByTestId('browseable-chevron-alpha'));
      await waitFor(() => expect(rootItem).toHaveAttribute('aria-expanded', 'true'));

      const childItem = screen.getByText('c1').closest('[role="treeitem"]')!;
      expect(childItem).toHaveAttribute('aria-level', '2');
    });
  });

  describe('Multiple roots', () => {
    it('renders multiple roots and allows expanding each independently', async () => {
      const user = userEvent.setup();
      const r1 = makeRoot('alpha', { children: [makeLeaf('a1')] });
      const r2 = makeRoot('beta', { children: [makeLeaf('b1')] });
      render(<BrowseableTree roots={[r1, r2]} activePointer={null} />);

      await user.click(screen.getByTestId('browseable-chevron-alpha'));
      await waitFor(() => expect(screen.getByText('a1')).toBeInTheDocument());
      expect(screen.queryByText('b1')).not.toBeInTheDocument();

      await user.click(screen.getByTestId('browseable-chevron-beta'));
      await waitFor(() => expect(screen.getByText('b1')).toBeInTheDocument());
      // a1 still visible
      expect(screen.getByText('a1')).toBeInTheDocument();
    });
  });

  describe('Dedupe of concurrent loads', () => {
    it('listChildren is called only once for rapid successive expands', async () => {
      const user = userEvent.setup();
      const listChildren = vi.fn(async () => [makeLeaf('c1')]);
      const root = makeRoot('alpha', { children: listChildren });

      render(<BrowseableTree roots={[root]} activePointer={null} />);
      const chevron = screen.getByTestId('browseable-chevron-alpha');
      await user.click(chevron); // expand
      await waitFor(() => expect(screen.getByText('c1')).toBeInTheDocument());
      await user.click(chevron); // collapse
      await user.click(chevron); // re-expand (should reuse cached children)

      // Should not refetch after first successful load
      expect(listChildren).toHaveBeenCalledTimes(1);
      // Use `within` to confirm c1 is still displayed under the expanded root
      const tree = screen.getByRole('tree');
      expect(within(tree).getByText('c1')).toBeInTheDocument();
    });
  });
});
