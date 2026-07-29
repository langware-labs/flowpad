/**
 * Bug #2 — a markdown file shared in a conversation opens in the CODE editor
 * instead of the markdown document editor.
 *
 * Drives the REAL conversation attachment row (`AttachmentRow` from
 * ConversationContextPanel) over a REAL local `.md` FILE attachment, with the
 * REAL `useDockNavigation` (a `NavigationActions` wired to react-router via
 * `<MemoryRouter>`). Clicking the row's "Open" action runs the exact handler
 * the conversation UI ships:
 *
 *     navigation.openDock(dockPointerForLocalFile(localPath))
 *
 * which routes a `.md` body to `/dock/assets/editor/markdown/…` (the markdown
 * document editor — rich Milkdown rendering with working internal-link
 * navigation), and every other file to `/dock/editor/…` (the code editor).
 *
 * The bug this locks: a shared markdown used to go through `openEditor` →
 * `ViewType.EDITOR`, opening as raw source in the code editor with dead links.
 *
 * No mock of the routing under test: the navigation object is real and the
 * resulting URL is observed from inside the same router. Only ambient boundary
 * hooks the row needs to mount are stubbed — never the routing decision.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '@lingui/react';
import { i18n } from '@lingui/core';
import { AttachmentType, type Attachment } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { AttachmentRow } from '@src/components/conversation/ConversationContextPanel';
import '@src/i18n-init'; // activates the default locale on the shared i18n

const MD_LOCAL_PATH = '/tmp/flowmsg_unpack_x/data/ziv-shared-note.md';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="router-location">{location.pathname + location.search}</div>;
}

function mdAttachment(): Attachment {
  return {
    attachment_type: AttachmentType.FILE,
    data: 'data/ziv-shared-note.md',
    local_path: MD_LOCAL_PATH,
  };
}

function renderRow() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <LocationProbe />
      <I18nProvider i18n={i18n}>
        <TooltipProvider>
          <AttachmentRow
            messageId="11111111-1111-4111-8111-111111111111"
            attachment={mdAttachment()}
            kind="file"
            originMessageIds={[]}
            isHighlighted={false}
          />
        </TooltipProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe('opening a markdown shared in a conversation', () => {
  it('opens in the markdown document editor, not the code editor', () => {
    renderRow();

    // The "Open" affordance the receiver clicks on the shared .md chip.
    fireEvent.click(screen.getByTitle(/^Open /));

    const dest = screen.getByTestId('router-location').textContent ?? '';
    // THE BUG: the shared markdown lands in the CODE editor — its dock VIEW
    // segment is `editor` (`/dock/editor/...`). (Note: the markdown asset editor
    // URL is `/dock/assets/editor/markdown/...`, which also contains the
    // substring `editor` — so assert on the leading VIEW segment, not anywhere.)
    expect(dest).not.toMatch(/^\/dock\/editor\//);
    // It must land in the markdown document editor (the assets markdown surface,
    // `/dock/assets/editor/markdown/...` — rich rendering + working links).
    expect(dest).toMatch(/^\/dock\/assets\/editor\/markdown\//);
  });
});
