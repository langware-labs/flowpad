import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MessageSquare, Link2 } from 'lucide-react';
import {
  TabbedSideDrawer,
  type TabDescriptor,
} from '@src/components/ui/side-drawer';

type Id = 'chat' | 'backlinks';

const TABS: TabDescriptor<Id>[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'backlinks', label: 'Backlinks', icon: Link2 },
];

function Harness({
  initial = 'chat' as Id,
  onOpenChange,
}: {
  initial?: Id;
  onOpenChange?: (open: boolean) => void;
}) {
  const [active, setActive] = useState<Id>(initial);
  return (
    <TabbedSideDrawer<Id>
      open
      tabs={TABS}
      activeTab={active}
      onActiveTabChange={setActive}
      onOpenChange={onOpenChange}
      data-testid="d"
      tabTestIdPrefix="d-tab"
    >
      {{
        chat: <div data-testid="panel-chat">chat-body</div>,
        backlinks: <div data-testid="panel-backlinks">backlinks-body</div>,
      }}
    </TabbedSideDrawer>
  );
}

describe('TabbedSideDrawer', () => {
  it('renders only the active tab panel', () => {
    render(<Harness initial="chat" />);
    expect(screen.getByTestId('panel-chat')).toBeDefined();
    expect(screen.queryByTestId('panel-backlinks')).toBeNull();
  });

  it('switches panels on tab click', () => {
    render(<Harness initial="chat" />);
    fireEvent.click(screen.getByTestId('d-tab-backlinks'));
    expect(screen.getByTestId('panel-backlinks')).toBeDefined();
    expect(screen.queryByTestId('panel-chat')).toBeNull();
  });

  it('applies tab-trigger testid from tabTestIdPrefix', () => {
    render(<Harness />);
    expect(screen.getByTestId('d-tab-chat')).toBeDefined();
    expect(screen.getByTestId('d-tab-backlinks')).toBeDefined();
  });

  it('renders close X when onOpenChange provided and fires on click', () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByTestId('d-close'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('omits close X when onOpenChange not provided', () => {
    render(<Harness />);
    expect(screen.queryByTestId('d-close')).toBeNull();
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <TabbedSideDrawer<Id>
        open={false}
        tabs={TABS}
        activeTab="chat"
        onActiveTabChange={() => {}}
      >
        {{ chat: <div>x</div>, backlinks: <div>y</div> }}
      </TabbedSideDrawer>,
    );
    expect(container.firstChild).toBeNull();
  });
});
