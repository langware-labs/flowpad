import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@src/components/ui/tooltip';

const { openExternal, openWikiModal } = vi.hoisted(() => ({
  openExternal: vi.fn(),
  openWikiModal: vi.fn(),
}));
vi.mock('@src/lib/open-external', () => ({ openExternal }));
vi.mock('@src/components/wiki-tip/wiki-modal', () => ({ openWikiModal }));

import { EntityIcon } from '@src/components/graph-view/ui/EntityIcon';

/**
 * The location glyphs are the entity's *reachable* locations, and each one goes
 * where it points. The contract that matters to every other surface: a glyph
 * with no link prop stays the inert indicator it has always been — lists must
 * not sprout buttons (or the backend round-trip behind them).
 *
 * The two event libraries are deliberate, not drift: `fireEvent.click` for
 * activation (it bubbles, so the row-propagation assertion below still means
 * something), `userEvent.hover` for the Radix tip, which only opens on a real
 * pointer sequence.
 */
function renderIcon(props: React.ComponentProps<typeof EntityIcon>) {
  return render(
    <TooltipProvider delayDuration={0}>
      <EntityIcon {...props} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EntityIcon location links', () => {
  it('leaves every glyph inert when no link props are passed', () => {
    const { container } = renderIcon({ type: 'skill', remote: false, 'aria-label': 'Skill' });
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[data-location-glyph="git"]')).toBeNull();
    // Still a single labelled image, exactly as before.
    expect(container.querySelector('[data-entity-location="local"]')).toHaveAttribute('role', 'img');
  });

  it('opens the repo page from the git glyph without disturbing the row', () => {
    const rowClick = vi.fn();
    const { container, getByTestId } = render(
      <TooltipProvider delayDuration={0}>
        <div onClick={rowClick}>
          <EntityIcon type="skill" remote={false} gitUrl="https://github.com/acme/repo/blob/main/a.md" gitLabel="acme/repo" />
        </div>
      </TooltipProvider>,
    );

    fireEvent.click(getByTestId('entity-icon-git-link'));
    expect(openExternal).toHaveBeenCalledWith('https://github.com/acme/repo/blob/main/a.md');
    // The frame lives inside clickable rows — activating a glyph must not select.
    expect(rowClick).not.toHaveBeenCalled();
    expect(container.querySelector('[data-location-glyph="git"]')).toBeInTheDocument();
  });

  it('opens the hub page from the cloud glyph', () => {
    const { getByTestId } = renderIcon({ type: 'task', remote: true, cloudUrl: 'https://hub.test/task/abc' });
    fireEvent.click(getByTestId('entity-icon-cloud-link'));
    expect(openExternal).toHaveBeenCalledWith('https://hub.test/task/abc');
  });

  it('reveals via the caller-supplied callback from the local glyph', () => {
    const onRevealLocal = vi.fn();
    const { getByTestId } = renderIcon({ type: 'markdown', remote: false, onRevealLocal });
    fireEvent.click(getByTestId('entity-icon-local-link'));
    expect(onRevealLocal).toHaveBeenCalledTimes(1);
  });

  it('keeps the entity name reachable once a glyph becomes a button', () => {
    const { container } = renderIcon({
      type: 'skill',
      remote: false,
      'aria-label': 'My skill',
      onRevealLocal: vi.fn(),
    });
    const frame = container.querySelector('[data-entity-location="local"]')!;
    // role="img" would swallow the button, so the frame becomes a labelled group
    // rather than dropping its name.
    expect(frame).toHaveAttribute('role', 'group');
    expect(frame).toHaveAccessibleName('My skill, Local only');
  });

  it('says what a click does, and offers Learn more at the glyph’s own section', async () => {
    const user = userEvent.setup();
    const { container, findByText } = renderIcon({
      type: 'task',
      remote: true,
      cloudUrl: 'https://hub.test/task/abc',
    });
    await user.hover(container.querySelector('[data-location-glyph="cloud"]')!);
    expect(await findByText('On the cloud, click to open.')).toBeInTheDocument();

    await user.click(await findByText('Learn more'));
    // Not the bare glyph key: the deep-link scroll matches a heading slug across
    // the whole document, so `cloud` would collide with the doc open behind it.
    expect(openWikiModal).toHaveBeenCalledWith(
      'Where your assets live',
      undefined,
      'the-cloud-badge',
    );
  });

  it('keeps inert glyphs on a plain tooltip — no hover card, no wiki round-trip', async () => {
    const user = userEvent.setup();
    // What every list renders. A HoverCard per row would be both a behaviour
    // change and a per-row cost.
    const { container, findByRole, queryByText } = renderIcon({ type: 'skill', remote: false });
    await user.hover(container.querySelector('[data-location-glyph="local"]')!);
    expect(await findByRole('tooltip')).toHaveTextContent('Local only');
    expect(queryByText('Learn more')).toBeNull();
  });

  it('suppresses both the tooltip and the tip when the caller turns them off', async () => {
    const user = userEvent.setup();
    const { container, queryByRole, queryByText } = renderIcon({
      type: 'markdown',
      remote: false,
      onRevealLocal: vi.fn(),
      showLocationTooltip: false,
    });
    await user.hover(container.querySelector('[data-location-glyph="local"]')!);
    expect(queryByRole('tooltip')).toBeNull();
    expect(queryByText('Learn more')).toBeNull();
    // …but the glyph is still a working button.
    expect(container.querySelector('[data-testid="entity-icon-local-link"]')).toBeInTheDocument();
  });

  it('shows git alongside the local glyph, in location order', () => {
    const { container } = renderIcon({
      type: 'markdown',
      remote: false,
      onRevealLocal: vi.fn(),
      gitUrl: 'https://github.com/acme/repo',
    });
    const glyphs = [...container.querySelectorAll('[data-location-glyph]')].map((g) =>
      g.getAttribute('data-location-glyph'),
    );
    expect(glyphs).toEqual(['local', 'git']);
  });
});
