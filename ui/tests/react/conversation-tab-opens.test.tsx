/**
 * React render: "ask"-create a conversation, open it, and the tab chip that
 * opens in the strip must be labeled with the asked subject — not the generated
 * `conversation-<id>` placeholder.
 *
 * Renders the REAL strip chips (`useTabStripItems` → `<TabStrip>`) off the REAL
 * conversation tab the loader materializes on open: a `TabRow` whose `name` is
 * exactly what `dataManager.getTabName(dock)` resolves for the opened
 * conversation dock (`DockPointer.forConversation`). No mocks of the strip or
 * the label resolution. Fails today (the chip shows the placeholder); passes
 * once the tab label surfaces the conversation's `title`.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { dataManager, Conversation, Tab } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { TabStrip } from '@src/components/tabs/TabStrip';
import { useTabStripItems } from '@src/tabs/tab-row-item';

void Conversation; // ensure the Conversation entity type is registered

/** The real content-panel strip chips, fed real TabRows. */
function Strip({ rows }: { rows: Tab[] }) {
  const items = useTabStripItems(rows);
  return (
    <TabStrip
      items={items}
      activeKey={rows[0] ? rows[0].getKey() : ''}
      onSelect={() => {}}
      onClose={() => {}}
    />
  );
}

describe('opening an "ask"-created conversation opens a correctly-named tab', () => {
  it('shows the opened tab chip labeled with the conversation subject, not the conversation-<id> placeholder', () => {
    const id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const subject = 'Login bug';

    // 1. "ask" create: the user's subject lands in `title`; `name` is the
    //    generated placeholder the server returns (observed live).
    dataManager.updateEntityFromJson({
      type: 'conversation',
      id,
      name: `conversation-${id.slice(0, 8)}`,
      title: subject,
    });

    // 2. open it → the loader materializes a Tab named getTabName(dock).
    const dock = DockPointer.forConversation(id);
    const row = new Tab({
      id,
      pointer: dock.tabHash ?? '',
      target_type: 'conversation',
      target_id: id,
      project_id: null,
      name: dataManager.getTabName(dock),
      icon_key: null,
      worktree: false,
      tab_order: 0,
      last_active_at: null,
      status: null,
      is_disabled: false,
    });

    // 3. render the strip — the tab opens with a chip labeled by the subject.
    //    Wrapped in a Router: TabStrip transitively uses navigation hooks.
    render(
      <MemoryRouter>
        <Strip rows={[row]} />
      </MemoryRouter>,
    );

    // the opened tab chip reads the asked subject (not the conversation-<id>
    // placeholder). getByText throws + dumps the DOM if it's not there.
    expect(screen.getByText(subject)).toBeInTheDocument();
  });
});
