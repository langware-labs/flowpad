import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@src/components/ui/tooltip';

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock('@src/lib/open-external', () => ({ openExternal }));

import { EntityIcon } from '@src/components/graph-view/ui/EntityIcon';

/**
 * The location glyphs are the entity's *reachable* locations, and each one goes
 * where it points. The contract that matters to every other surface: a glyph
 * with no link prop stays the inert indicator it has always been — lists must
 * not sprout buttons (or the backend round-trip behind them).
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
