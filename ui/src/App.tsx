import '@src/styles/highlightjs.css';
import { trackEvent } from '@src/utils/analytics';
import { CapabilityKinds, config, navigator } from '@sdk';
import { useAuth, useCapability, useGlobalEvents } from '@sdk/react/hooks';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationOutlet, NotificationCommandBridge, initNotificationIngest } from '@src/notifications';
import { ActivityProgressModalRoot } from '@src/components/search-index/ActivityProgressModalRoot';
import { CleanupModal } from '@src/components/recovery/cleanup-modal';
import { DeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { useEffect, useRef } from 'react';
import { GitHubDeviceFlowModal } from '@src/components/oauth/GitHubDeviceFlowModal';
import SecretApprovalDialog from '@src/components/secret-approval-dialog';
import { initNotificationListener } from '@src/store/use-notification-store';
import { SnifferProvider } from '@src/contexts/SnifferContext';
import { FloatingChatProvider } from '@src/components/floating-chat';
import { usePresenceReporter } from '@src/hooks/use-presence-reporter';
import { useUiCommandListener } from '@src/hooks/use-ui-command-listener';
import { Spotlight, useSpotlightHotkey } from '@src/components/spotlight';

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

// Warm the capability cache at startup so harness consumers (interactive tab
// openers, capability badges) render from a settled snapshot instead of each
// triggering its own first check. Module-level so AppContent re-renders don't
// remount it.
const CapabilityWarmup = () => {
  useCapability(CapabilityKinds.ClaudeCode);
  useCapability(CapabilityKinds.Codex);
  return null;
};

// Component that handles auth logic
const AppContent = ({ children }: { children: React.ReactNode }) => {
  const { user, someone } = useAuth();
  const analyticsTrackingRef = useRef(false);

  const GlobalEvents = () => {
    void useGlobalEvents();
    usePresenceReporter();
    useUiCommandListener();
    useSpotlightHotkey();
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
        <CleanupModal />
        <DeleteAssetModal />
        <Spotlight />
        <ActivityProgressModalRoot />
        <GlobalEvents />
        <CapabilityWarmup />
        <GitHubDeviceFlowModal />
        <SecretApprovalDialog />
        <SnifferProvider>
          <FloatingChatProvider>
            {children}
          </FloatingChatProvider>
        </SnifferProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

const App = ({ children }: { children: React.ReactNode }) => {
  return <AppContent>{children}</AppContent>;
};

export default App;
