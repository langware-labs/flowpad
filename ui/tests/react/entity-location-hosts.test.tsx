import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { AssetDescriptor } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { AssetRow } from '@src/components/asset-manager/AssetManagerPopover';
import { assetScope } from '@src/components/asset-manager/asset-scope';
import {
  DirTreeItemIconButton,
  type PathAsset,
} from '@src/components/terminal/interactive-terminal/side-windows/SimpleDirTree';

const ID = '11111111-1111-4111-8111-111111111111';

function descriptor(remote?: boolean): AssetDescriptor {
  return {
    typeid: `skill-${ID}`,
    source: 'embedded',
    posix_path: '/tmp/remote-kit',
    source_dir: '/tmp',
    remote,
  };
}

function Host({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <TooltipProvider>{children}</TooltipProvider>
    </MemoryRouter>
  );
}

describe('entity location text owned by interactive hosts', () => {
  // The name chip is the OPEN-IN-EDITOR control, and it is what carries the
  // entity icon — so it is the button that must carry the location text.
  // Explorer ("show the file") and select are separate buttons alongside it.
  it('AssetRow appends cloud state to its native title and explicit action label', () => {
    const row = descriptor(true);
    render(
      <Host>
        <AssetRow
          descriptor={row}
          scope={assetScope(row)}
          label="Remote kit"
          selected={false}
          improvable={false}
          busy={false}
          onPick={vi.fn()}
          onUnpick={vi.fn()}
          onImprove={vi.fn()}
        />
      </Host>,
    );

    const host = screen.getByTestId(`asset-manager-row-${row.typeid}-${row.source}`);
    const open = within(host).getByTestId(`asset-manager-open-${row.typeid}-${row.source}`);
    expect(open).toHaveAccessibleName('Open Remote kit, Available on cloud');
    expect(open).toHaveAttribute('title', 'Open Remote kit\nAvailable on cloud');
    expect(open.querySelector('[data-entity-location="cloud"]')).toBeTruthy();
    expect(within(host).getByTestId(`asset-manager-explorer-${row.typeid}-${row.source}`)).toHaveAccessibleName(
      'Show Remote kit in Files',
    );
  });

  it('AssetRow appends local state to its open title and explicit action label', () => {
    const row = descriptor(false);
    render(
      <Host>
        <AssetRow
          descriptor={row}
          scope={assetScope(row)}
          label={row.typeid}
          selected={false}
          improvable={false}
          busy={false}
          onPick={vi.fn()}
        />
      </Host>,
    );

    const host = screen.getByTestId(`asset-manager-row-${row.typeid}-${row.source}`);
    const open = within(host).getByRole('button', { name: `Open ${row.typeid}, Local only` });
    expect(open).toHaveAttribute('title', `Open ${row.typeid}\nLocal only`);
    expect(open.querySelector('[data-entity-location="local"]')).toBeTruthy();
  });

  it('SimpleDirTree icon button owns cloud title and accessible label', () => {
    const asset: PathAsset = {
      id: ID,
      type: 'markdown',
      name: 'notes.md',
      asset_ref: '/tmp/notes.md',
      remote: true,
    };
    render(
      <Host>
        <DirTreeItemIconButton item={{ name: 'notes.md' }} asset={asset} childPath="/tmp/notes.md" onClick={vi.fn()} />
      </Host>,
    );

    const button = screen.getByRole('button', {
      name: 'Open markdown: notes.md, /tmp/notes.md, Available on cloud',
    });
    expect(button).toHaveAttribute('title', 'Open markdown: notes.md\n/tmp/notes.md\nAvailable on cloud');
  });

  it('does not invent a local/cloud host claim for unknown state', () => {
    const row = descriptor();
    render(
      <Host>
        <AssetRow
          descriptor={row}
          scope={assetScope(row)}
          label={row.typeid}
          selected={false}
          improvable={false}
          busy={false}
          onPick={vi.fn()}
        />
      </Host>,
    );

    const host = screen.getByTestId(`asset-manager-row-${row.typeid}-${row.source}`);
    const open = within(host).getByRole('button', { name: `Open ${row.typeid}` });
    expect(open.getAttribute('aria-label')).not.toMatch(/Available on cloud|Local only/);
    expect(open.getAttribute('title')).not.toMatch(/Available on cloud|Local only/);
    expect(open.querySelector('[data-entity-location="unknown"]')).toBeTruthy();
  });
});
