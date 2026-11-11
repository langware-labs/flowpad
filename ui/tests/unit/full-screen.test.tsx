import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FullScreenButton, FullScreenView } from '@src/components/ui/full-screen';

afterEach(cleanup);

describe('FullScreenView', () => {
  it('shows the header and the content over the window', () => {
    render(
      <FullScreenView open onExit={() => {}} title="Procurement agent" subtitle="Instructions">
        <p>the body</p>
      </FullScreenView>,
    );
    expect(screen.getByTestId('full-screen-view')).toHaveTextContent('Procurement agent');
    expect(screen.getByText('Instructions')).toBeInTheDocument();
    expect(screen.getByText('the body')).toBeInTheDocument();
  });

  it('exits from the Exit button and from Esc', () => {
    const onExit = vi.fn();
    render(
      <FullScreenView open onExit={onExit} title="T">
        <p>x</p>
      </FullScreenView>,
    );
    fireEvent.click(screen.getByTestId('full-screen-exit'));
    expect(onExit).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByTestId('full-screen-view'), { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(2);
  });

  it('renders nothing while closed', () => {
    render(
      <FullScreenView open={false} onExit={() => {}} title="T">
        <p>hidden body</p>
      </FullScreenView>,
    );
    expect(screen.queryByTestId('full-screen-view')).toBeNull();
    expect(screen.queryByText('hidden body')).toBeNull();
  });
});

describe('FullScreenButton', () => {
  it('is labelled and calls onClick', () => {
    const onClick = vi.fn();
    render(<FullScreenButton onClick={onClick} />);
    const button = screen.getByTestId('full-screen-open');
    expect(button).toHaveTextContent('Full screen');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
