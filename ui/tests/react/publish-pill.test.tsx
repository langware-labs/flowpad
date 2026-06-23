import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PublishPill } from '@src/components/git/PublishPill';

describe('PublishPill', () => {
  it('renders nothing when no repo', () => {
    const { container } = render(<PublishPill state="no-repo" versionLabel="v3" />);
    expect(container.firstChild).toBeNull();
  });

  it('aligned: shows version, no Publish action', () => {
    render(<PublishPill state="aligned" versionLabel="v3" onPrimary={vi.fn()} />);
    expect(screen.getByTestId('publish-pill-primary')).toHaveTextContent('v3');
    expect(screen.queryByTestId('publish-pill-action')).toBeNull();
  });

  it('unpublished: Publish fires, primary fires, count shown only with showCount', () => {
    const onPublish = vi.fn();
    const onPrimary = vi.fn();
    const { rerender } = render(
      <PublishPill state="unpublished" versionLabel="v3" pendingCount={2} showCount={false} onPrimary={onPrimary} onPublish={onPublish} />,
    );
    const action = screen.getByTestId('publish-pill-action');
    expect(action).toHaveTextContent('Publish');
    expect(action).not.toHaveTextContent('2'); // Standard: no count
    fireEvent.click(action);
    expect(onPublish).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('publish-pill-primary'));
    expect(onPrimary).toHaveBeenCalled();

    rerender(<PublishPill state="unpublished" versionLabel="v3" pendingCount={2} showCount onPublish={onPublish} />);
    expect(screen.getByTestId('publish-pill-action')).toHaveTextContent('2'); // Advanced: count
  });

  it('busy disables the Publish action', () => {
    render(<PublishPill state="unpublished" pendingCount={1} busy onPublish={vi.fn()} />);
    expect(screen.getByTestId('publish-pill-action')).toBeDisabled();
  });
});
