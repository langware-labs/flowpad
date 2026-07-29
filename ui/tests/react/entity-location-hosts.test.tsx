import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { AssetDescriptor } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';
import {
  AddModeRow,
  AssetRow,
} from '@src/components/asset-manager/AssetManagerPopover';
import { PickRow } from '@src/components/asset-manager/AssetPickerPopover';
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
  it('AssetRow appends cloud state to its native title and explicit action label', () => {
    const row = descriptor(true);
    render(
      <Host>
        <AssetRow
          descriptor={row}
          scope={assetScope(row)}
          label="Remote kit"
          attached={false}
          used={false}
          improvable={false}
          busy={false}
          onDetach={vi.fn()}
          onImprove={vi.fn()}
        />
      </Host>,
    );

    const host = screen.getByTestId(`asset-manager-row-${row.typeid}-${row.source}`);
    const open = within(host).getByRole('button', {
      name: 'Open Remote kit, Available on cloud',
    });
    expect(open).toHaveAttribute('title', 'Open Remote kit\nAvailable on cloud');
    expect(open.querySelector('[data-entity-location="cloud"]')).toBeTruthy();
  });

  it('PickRow appends local state to its select title and explicit action label', () => {
    const row = descriptor(false);
    render(
      <Host>
        <PickRow descriptor={row} onPick={vi.fn()} onPreview={vi.fn()} />
      </Host>,
    );

    const host = screen.getByTestId(`asset-picker-row-${row.typeid}`);
    expect(host).toHaveAccessibleName(`Select ${row.typeid}, Local only`);
    expect(host).toHaveAttribute('title', `Select ${row.typeid}\nLocal only`);
    expect(host.querySelector('[data-entity-location="local"]')).toBeTruthy();
  });

  it('AddModeRow exposes known state through checkbox-associated sr-only copy', () => {
    const row = descriptor(true);
    render(
      <Host>
        <AddModeRow descriptor={row} checked={false} onToggle={vi.fn()} />
      </Host>,
    );

    expect(screen.getByRole('checkbox')).toHaveAccessibleName(
      new RegExp(`${row.typeid}.*Available on cloud`, 'i'),
    );
    expect(screen.getByText('Available on cloud')).toHaveClass('sr-only');
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
        <DirTreeItemIconButton
          item={{ name: 'notes.md' }}
          asset={asset}
          childPath="/tmp/notes.md"
          onClick={vi.fn()}
        />
      </Host>,
    );

    const button = screen.getByRole('button', {
      name: 'Open markdown: notes.md, /tmp/notes.md, Available on cloud',
    });
    expect(button).toHaveAttribute(
      'title',
      'Open markdown: notes.md\n/tmp/notes.md\nAvailable on cloud',
    );
  });

  it('does not invent a local/cloud host claim for unknown state', () => {
    const row = descriptor();
    render(
      <Host>
        <PickRow descriptor={row} onPick={vi.fn()} onPreview={vi.fn()} />
      </Host>,
    );

    const host = screen.getByTestId(`asset-picker-row-${row.typeid}`);
    expect(host.getAttribute('aria-label')).not.toMatch(/Available on cloud|Local only/);
    expect(host.getAttribute('title')).not.toMatch(/Available on cloud|Local only/);
    expect(host.querySelector('[data-entity-location="unknown"]')).toBeTruthy();
  });
});
