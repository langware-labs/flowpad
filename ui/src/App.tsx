import '@src/styles/highlightjs.css';
import { trackEvent } from '@src/utils/analytics';
import { config, dataContext, navigator } from '@sdk';
import { useAuth, useGlobalEvents, useWarnings } from '@sdk/react/hooks';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationOutlet, NotificationCommandBridge, initNotificationIngest } from '@src/notifications';
import { ActivityProgressModalRoot } from '@src/components/search-index/ActivityProgressModalRoot';
import { CleanupModal } from '@src/components/recovery/cleanup-modal';
import { DeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { useEffect, useRef, useState } from 'react';
import { DesktopSetupModal, DESKTOP_SETUP_REASON_AUTH_FAILURE } from '@src/components/desktop-setup-modal';
import { GitHubDeviceFlowModal } from '@src/components/oauth/GitHubDeviceFlowModal';
import SecretApprovalDialog from '@src/components/secret-approval-dialog';
import MigrateLegacyKeychain from '@src/components/migrate-legacy-keychain';
import { initNotificationListener } from '@src/store/use-notification-store';
import { SnifferProvider } from '@src/contexts/SnifferContext';
import { FloatingChatProvider } from '@src/components/floating-chat';
import { usePresenceReporter } from '@src/hooks/use-presence-reporter';
import { useBrowserContextReporter } from '@src/hooks/use-browser-context-reporter';
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

// Component that handles desktop setup modal (must be inside QueryClientProvider)
const DesktopSetupModalHandler = () => {
  const { someone } = useAuth();
  const [showDesktopSetup, setShowDesktopSetup] = useState(false);
  const [authFailure, setAuthFailure] = useState(false);
  const { isOAuthConfigured, isLlmConfigLoading } = useWarnings();

  // Listen for custom event to open desktop setup modal
  useEffect(() => {
    const handleOpenDesktopSetup = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: string }>).detail;
      if (detail?.reason === DESKTOP_SETUP_REASON_AUTH_FAILURE) {
        setAuthFailure(true);
      }
      setShowDesktopSetup(true);
    };
    window.addEventListener('open-desktop-setup', handleOpenDesktopSetup);
    return () => {
      window.removeEventListener('open-desktop-setup', handleOpenDesktopSetup);
    };
  }, []);

  // Show desktop setup modal on first load if LLM is NOT configured
  useEffect(() => {
    if (!someone) return;

    // Wait for LLM config query to complete before deciding to show modal
    if (isLlmConfigLoading) return;

    // Check if desktop_info exists in bootstrap data (indicates desktop mode)
    const bootstrapInfo = dataContext.bootstrapInfo;
    const desktopInfo = bootstrapInfo?.desktop_info;
    const hasDesktopInfo = !!desktopInfo;

    // Show modal on first launch if the user didn't do oauth or has API key. If he has oauth, we don't need the modal.
    if (hasDesktopInfo && !showDesktopSetup && !isOAuthConfigured) {
      const hasSeenModal = localStorage.getItem('llm-setup-modal-seen');
      if (!hasSeenModal) {
        setShowDesktopSetup(true);
      }
    }
  }, [someone, showDesktopSetup, isOAuthConfigured, isLlmConfigLoading]);

  return (
    <DesktopSetupModal
      isOpen={showDesktopSetup}
      authFailure={authFailure}
      onClose={() => {
        setShowDesktopSetup(false);
        setAuthFailure(false);
        localStorage.setItem('llm-setup-modal-seen', 'true');
      }}
    />
  );
};

// Bootstrap-error UX is handled by the router's root `errorElement`
// (`<ErrorScreen/>` in `router.tsx`). The root loader (`loadRoot`) re-throws
// service-unavailable / network / config errors before any React tree mounts,
// so a parallel inline error UI here is no longer needed.

// Component that handles auth logic
const AppContent = ({ children }: { children: React.ReactNode }) => {
  const { user, someone } = useAuth();
  const analyticsTrackingRef = useRef(false);

  const GlobalEvents = () => {
    void useGlobalEvents();
    usePresenceReporter();
    useBrowserContextReporter();
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
        <DesktopSetupModalHandler />
        <GitHubDeviceFlowModal />
        <SecretApprovalDialog />
        <MigrateLegacyKeychain />
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
