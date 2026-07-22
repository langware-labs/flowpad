import '@src/styles/highlightjs.css';
import { trackEvent } from '@src/utils/analytics';
import { config, dataContext, navigator } from '@sdk';
import { useLocation } from 'react-router';
import { useAuth, useGlobalEvents } from '@sdk/react/hooks';
import { HarnessCapabilitiesProvider } from '@src/contexts/HarnessCapabilitiesContext';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationOutlet, NotificationCommandBridge, DiagnoseErrorModal, initNotificationIngest } from '@src/notifications';
import { ActivityProgressModalRoot } from '@src/components/search-index/ActivityProgressModalRoot';
import { WikiModalRoot } from '@src/components/wiki-tip/WikiModalRoot';
import { CleanupModal } from '@src/components/recovery/cleanup-modal';
import { DeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { InputPromptModal } from '@src/components/ui/input-prompt-modal';
import { ImageAnnotatorRoot } from '@src/components/image-annotator/image-annotator-store';
import { useEffect, useRef } from 'react';
import { GitHubDeviceFlowModal } from '@src/components/oauth/GitHubDeviceFlowModal';
import { HarnessLoginModalRoot } from '@src/components/harness-login/HarnessLoginModal';
import MigrateLegacyKeychain from '@src/components/migrate-legacy-keychain';
import { initNotificationListener } from '@src/store/use-notification-store';
import { SnifferProvider } from '@src/contexts/SnifferContext';
import { FloatingChatProvider } from '@src/components/floating-chat';
import { usePresenceReporter } from '@src/hooks/use-presence-reporter';
import { useUiCommandListener } from '@src/hooks/use-ui-command-listener';
import { Spotlight, useSpotlightHotkey } from '@src/components/spotlight';
import { JourneyController } from '@src/journey/JourneyController';
import { UiTopicEmitter } from '@src/topics/ui.onTopic';
import { TopicHighlightObserver } from '@src/topics/highlight.onTopic';
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

// The harness capability triple (Claude/Codex/Copilot) is owned by
// `HarnessCapabilitiesProvider` below: it subscribes once, warms the cache at
// startup, and every consumer (terminal strips, openers) reads the shared
// snapshots via `useHarnessCapabilities` instead of re-subscribing.

// Component that handles auth logic
const AppContent = ({ children }: { children: React.ReactNode }) => {
  const { user, someone } = useAuth();
  const analyticsTrackingRef = useRef(false);

  const GlobalEvents = () => {
    void useGlobalEvents();
    usePresenceReporter();
    useUiCommandListener();
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
        <DiagnoseErrorModal />
        <CleanupModal />
        <DeleteAssetModal />
        <InputPromptModal />
        <ImageAnnotatorRoot />
        <Spotlight />
        <UiTopicEmitter />
        <TopicHighlightObserver />
        <JourneyController />
        <ActivityProgressModalRoot />
        <WikiModalRoot />
        <GlobalEvents />
        <GitHubDeviceFlowModal />
        {/* Harness/LLM-keys setup is a desktop-only concern (local coding CLIs);
            it has no place in hub mode. */}
        {!isHubOnly() && <HarnessLoginModalRoot />}
        <MigrateLegacyKeychain />
        <HarnessCapabilitiesProvider>
          <SnifferProvider>
            <FloatingChatProvider>
              {children}
            </FloatingChatProvider>
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
