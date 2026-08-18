import '@src/styles/highlightjs.css';
import { trackEvent } from '@src/utils/analytics';
import { config, dataContext, navigator } from '@sdk';
import { useLocation } from 'react-router';
import { useAuth, useGlobalEvents } from '@sdk/react/hooks';
import { HarnessCapabilitiesProvider } from '@src/contexts/HarnessCapabilitiesContext';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationOutlet, NotificationCommandBridge, initNotificationIngest } from '@src/notifications';
import { ActivityProgressModalRoot } from '@src/components/search-index/ActivityProgressModalRoot';
import { WikiModalRoot } from '@src/components/wiki-tip/WikiModalRoot';
import { RunPreviewRoot } from '@src/components/runs/RunPreviewRoot';
import { FilePreviewRoot } from '@src/components/file-preview/FilePreviewRoot';
import { CleanupModal } from '@src/components/recovery/cleanup-modal';
import { DeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { InputPromptModal } from '@src/components/ui/input-prompt-modal';
import { ImageAnnotatorRoot } from '@src/components/image-annotator/image-annotator-store';
import { useEffect, useRef } from 'react';
import { GitHubDeviceFlowModal } from '@src/components/oauth/GitHubDeviceFlowModal';
import { HarnessLoginModalRoot } from '@src/components/harness-login/HarnessLoginModal';
import MigrateLegacyKeychain from '@src/components/migrate-legacy-keychain';
import { SnifferActiveNotice } from '@src/components/hooks/SnifferActiveNotice';
import { SnifferProvider } from '@src/contexts/SnifferContext';
import { FloatingChatProvider } from '@src/components/floating-chat';
import { usePresenceReporter } from '@src/hooks/use-presence-reporter';
import { useUiCommandListener } from '@src/hooks/use-ui-command-listener';
import { useShowTargetListener } from '@src/hooks/use-show-target-listener';
import { useSyncOsBadge } from '@src/hooks/useInboxManager';
import { Spotlight, useSpotlightHotkey } from '@src/components/spotlight';
import { JourneyController } from '@src/journey/JourneyController';
import { IncomingDeepLink } from '@src/components/task-receive/IncomingDeepLink';
import { UiTagEmitter } from '@src/tags/ui.onTag';
import { TagHighlightObserver } from '@src/tags/highlight.onTag';
import { useDockViewModeOverrideSync } from '@src/contexts/view-mode-context';
import { isHubOnly } from '@src/navigation/hub-runtime';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// Bootstrap-error UX is handled by the router's root `errorElement`
// (`<ErrorScreen/>` in `router.tsx`). The root loader (`loadRoot`) re-throws
// service-unavailable / network / config errors before any React tree mounts,
// so a parallel inline error UI here is no longer needed.

// The harness capability set (default reference + Claude/Codex/Copilot) is owned by
// `HarnessCapabilitiesProvider` below: it subscribes once, loads persisted
// snapshots without executing external harness probes, and every consumer
// reads them via `useHarnessCapabilities`. Launch/setup actions perform the
// definitive on-demand check.

// Component that handles auth logic
const AppContent = ({ children }: { children: React.ReactNode }) => {
  const { user, someone } = useAuth();
  const analyticsTrackingRef = useRef(false);

  const GlobalEvents = () => {
    void useGlobalEvents();
    usePresenceReporter();
    useUiCommandListener();
    // `flow show` outside vibe — mints the shown target as a tab beside the
    // calling process (never navigates). Vibe's own display surfaces own the
    // vibe branch, so this no-ops there.
    useShowTargetListener();
    // OS dock/launcher badge = the backend-owned InboxManager.unread (state,
    // not a notification event) — mounted once, next to the WS listeners.
    useSyncOsBadge();
    useDockViewModeOverrideSync();
    useSpotlightHotkey();
    // Re-report browser_context (incl. the current URL) on every navigation.
    // The reporter's mobx autorun only fires on context-slot changes, so a
    // pure-URL move (e.g. leaving a conversation for Home) wouldn't otherwise
    // refresh the pathname the backend reads to tell what page is open.
    const { pathname } = useLocation();
    useEffect(() => {
      dataContext.resendBrowserContext();
    }, [pathname]);
    return null;
  };

  // Wire all WS-driven notifications (hub errors, bootstrap notice, skill/task badges).
  useEffect(() => {
    const cleanup = initNotificationIngest();
    return cleanup;
  }, []);

  // Visitor is now handled by bootstrap - no need for ensureVisitor()

  useEffect(() => {
    if (analyticsTrackingRef.current || !someone) return;
    analyticsTrackingRef.current = true;

    let eventName = 'visit';
    if (user) {
      if (navigator.checkAndRemoveQueryParam && navigator.checkAndRemoveQueryParam(config.LOGIN_QUERY_PARAM)) {
        eventName = 'login';
      } else if (navigator.checkAndRemoveQueryParam && navigator.checkAndRemoveQueryParam(config.SIGNUP_QUERY_PARAM)) {
        eventName = 'sign_up';
      }
    }

    trackEvent({
      user_id: user?.id ?? null,
      event: eventName,
    });
  }, [someone, user]);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <NotificationOutlet />
        <NotificationCommandBridge />
        {/* `<DiagnoseErrorModal/>` is mounted in `main.tsx`, above the router:
            the root error boundary replaces this whole tree, and the error
            screen's diagnose button still needs a host. */}
        <CleanupModal />
        <DeleteAssetModal />
        <InputPromptModal />
        <ImageAnnotatorRoot />
        <Spotlight />
        <UiTagEmitter />
        <TagHighlightObserver />
        <JourneyController />
        {/* `?action=open&…` — must be app-level: the app has several homes and a
            box opens on whichever the view mode picks. */}
        <IncomingDeepLink />
        <ActivityProgressModalRoot />
        <WikiModalRoot />
        <RunPreviewRoot />
        <FilePreviewRoot />
        <GlobalEvents />
        <GitHubDeviceFlowModal />
        {/* Harness/LLM-keys setup is a desktop-only concern (local coding CLIs);
            it has no place in hub mode. */}
        {!isHubOnly() && <HarnessLoginModalRoot />}
        <MigrateLegacyKeychain />
        <SnifferActiveNotice />
        <HarnessCapabilitiesProvider>
          <SnifferProvider>
            <FloatingChatProvider>{children}</FloatingChatProvider>
          </SnifferProvider>
        </HarnessCapabilitiesProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

const App = ({ children }: { children: React.ReactNode }) => {
  return <AppContent>{children}</AppContent>;
};

export default App;
