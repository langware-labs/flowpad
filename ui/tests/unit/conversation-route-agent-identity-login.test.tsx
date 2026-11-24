/**
 * FLOWPAD-2383: a deployed agent's box is signed in to the hub as its Identity, which by design leaves
 * `cloudUser` (a person only) empty. The conversation page gated its "Login required" overlay on
 * `cloudUser`, so the agent's box was told to log in over a conversation it can read.
 */
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CONVERSATION_ID = '77e82071-ae2e-4478-b9f0-7bf2e6d96e93';

vi.mock('@src/navigation/useDockNavigation', async () => {
  const { ViewType } = await import('@src/types/ViewType');
  return {
    useDockNavigation: () => ({
      navigation: { openDock: vi.fn() },
      currentDock: { viewType: ViewType.CONVERSATION, pointer: CONVERSATION_ID },
    }),
  };
});
// The conversation is not cached on this box: the page is at its gate, before any conversation chrome.
vi.mock('@src/components/conversation/useConversation', () => ({
  useConversation: () => ({ conversation: null, task: null, senderName: null, taskMissing: false }),
}));

const { cloudManager, dataContext } = await import('@sdk');
const { SidebarProvider } = await import('@src/components/ui/sidebar');
const { ConversationRoute } = await import('@src/components/conversation/ConversationRoute');

function Shell({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <SidebarProvider>{children}</SidebarProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

const AGENT_IDENTITY = {
  type: 'identity',
  id: 'a5380803-76a9-4e1e-8854-d1e5d0f308d3',
  name: 'Spora QA Bot',
  subject_typeid: 'agent-04f3ab7a-d33b-48c0-ae0e-6e61e181a343',
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// flowpad:capsule tag
// version: 1
// data:
//   tags:
//     breadcrumb.test.agent_identity_login.rules: FAILING? read this tag's rules before
//       editing — an agent Identity is signed in although cloudUser is null
// flowpad:endcapsule tag
describe("a conversation page on an agent's box", () => {
  it('asks to log in until the hub signs the box in as its agent Identity, then opens the conversation', async () => {
    render(<ConversationRoute />, { wrapper: Shell });
    expect(screen.getByTestId('login-required-overlay')).toBeTruthy();

    // The box's bootstrap seed: signed in, no person, the agent's Identity as the principal.
    await act(() =>
      cloudManager.seedBootstrap({
        user: null,
        desktop_info: {
          cloud_url: 'https://hub.test',
          login: { status: 'logged_in', user: null, principal: AGENT_IDENTITY, reason: null },
        },
      } as never),
    );
    expect(dataContext.signedInAsIdentity).toBe(true);
    expect(dataContext.cloudUser).toBeNull();

    await waitFor(() => expect(screen.queryByTestId('login-required-overlay')).toBeNull());
    expect(screen.getByText('Loading conversation…')).toBeTruthy();
  });
});
