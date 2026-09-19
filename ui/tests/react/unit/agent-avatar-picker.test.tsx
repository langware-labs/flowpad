import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Agent } from '@sdk';
import { AgentAvatar } from '@src/components/agents/AgentAvatar';
import { AgentAvatarPicker } from '@src/components/ui/agent-avatar-picker';

const noop = () => {};

describe('AgentAvatarPicker', () => {
  it('is ONE tab row — icons, emoji, image — with no nested icon tabs', () => {
    render(<AgentAvatarPicker value={null} onValueChange={noop} onImageSelected={noop} onColorChange={noop} />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Icons', 'Emoji', 'Image']);
  });

  it('opens on the tab that holds the current avatar', () => {
    render(<AgentAvatarPicker value="🔥" onValueChange={noop} onImageSelected={noop} onColorChange={noop} />);
    expect(screen.getByRole('tab', { name: 'Emoji' })).toHaveAttribute('aria-selected', 'true');
  });

  it('picking a swatch fires its hex; the none cell fires null', async () => {
    const onColorChange = vi.fn();
    render(
      <AgentAvatarPicker
        value={null}
        color="#dc2626"
        onValueChange={noop}
        onImageSelected={noop}
        onColorChange={onColorChange}
      />,
    );
    await userEvent.click(screen.getByRole('option', { name: 'blue' }));
    expect(onColorChange).toHaveBeenLastCalledWith('#3b82f6');
    await userEvent.click(screen.getByRole('option', { name: 'No color' }));
    expect(onColorChange).toHaveBeenLastCalledWith(null);
  });
});

describe('AgentAvatar color', () => {
  it('paints the chosen color instead of the name-derived one', () => {
    render(<AgentAvatar agent={new Agent({ name: 'a', color: '#3b82f6' })} data-testid="face" />);
    const face = screen.getByTestId('face');
    expect(face).toHaveStyle({ backgroundColor: '#3b82f6' });
    expect(face.className).not.toMatch(/\bbg-/);
  });

  it('falls back to the identity color when unset', () => {
    render(<AgentAvatar agent={new Agent({ name: 'a' })} data-testid="face" />);
    expect(screen.getByTestId('face').className).toMatch(/\bbg-/);
  });
});
