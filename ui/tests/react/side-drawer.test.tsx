import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SideDrawer } from '@src/components/ui/side-drawer';

describe('SideDrawer', () => {
  it('renders children when open', () => {
    render(
      <SideDrawer open data-testid="d">
        <div data-testid="body">hello</div>
      </SideDrawer>,
    );
    expect(screen.getByTestId('body').textContent).toBe('hello');
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <SideDrawer open={false}>
        <div>hidden</div>
      </SideDrawer>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows title and count badge', () => {
    render(
      <SideDrawer open title="Runs" count={3}>
        <div />
      </SideDrawer>,
    );
    expect(screen.getByText('Runs')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
  });

  it('renders X close button when onOpenChange is provided and fires on click', () => {
    const onOpenChange = vi.fn();
    render(
      <SideDrawer open onOpenChange={onOpenChange} data-testid="d">
        <div />
      </SideDrawer>,
    );
    const close = screen.getByTestId('d-close');
    fireEvent.click(close);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('omits the X close button when onOpenChange is not provided', () => {
    render(
      <SideDrawer open title="Runs" data-testid="d">
        <div />
      </SideDrawer>,
    );
    expect(screen.queryByTestId('d-close')).toBeNull();
  });

  it('applies width class', () => {
    render(
      <SideDrawer open width="w-44" data-testid="d" title="x">
        <div />
      </SideDrawer>,
    );
    expect(screen.getByTestId('d').className).toContain('w-44');
  });
});
