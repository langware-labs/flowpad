/**
 * ContextEntityChip renders a muted, non-navigable "unavailable" chip when its
 * target 404s (``useEntity().notFound``), instead of falling back to the raw
 * typeid string and re-fetching. A resolvable target renders normally.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypeId } from '@sdk';

const { mockUseEntity, openDock } = vi.hoisted(() => ({
  mockUseEntity: vi.fn(),
  openDock: vi.fn(),
}));

vi.mock('@sdk/react/hooks', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, useEntity: (...args: unknown[]) => mockUseEntity(...args) };
});

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock }, currentDock: null, currentTab: null }),
}));

import { ContextEntityChip } from '@src/components/conversation/EntityChip';

const SPEC = new TypeId('spec', '22222222-aaaa-4bbb-9ccc-000000000099');

describe('ContextEntityChip muted on notFound', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders a disabled "unavailable" chip when the target 404s', () => {
    mockUseEntity.mockReturnValue({ data: null, notFound: true });
    render(<ContextEntityChip typeId={SPEC} />);

    const chip = screen.getByTestId(`entity-chip-spec-${SPEC.id}`) as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    expect(chip.textContent).toMatch(/unavailable/i);
    expect(chip.className).toMatch(/line-through/);
  });

  it('renders a normal, enabled chip when the target resolves', () => {
    mockUseEntity.mockReturnValue({ data: { displayName: 'My Spec' }, notFound: false });
    render(<ContextEntityChip typeId={SPEC} />);

    const chip = screen.getByTestId(`entity-chip-spec-${SPEC.id}`) as HTMLButtonElement;
    expect(chip.disabled).toBe(false);
    expect(chip.textContent).toContain('My Spec');
    expect(chip.className).not.toMatch(/line-through/);
  });
});
