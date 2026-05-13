import '@src/styles/highlightjs.css';
import { trackEvent } from '@src/utils/analytics';
import { cloudManager, config, dataContext, navigator } from '@sdk';
import { useAuth, useGlobalEvents, useWarnings } from '@sdk/react/hooks';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster as Sonner, toast } from 'sonner';
import { Toaster } from '@src/components/ui/toaster';
import { CleanupModal } from '@src/components/recovery/cleanup-modal';
import { useEffect, useRef, useState } from 'react';
import { DesktopSetupModal, DESKTOP_SETUP_REASON_AUTH_FAILURE } from '@src/components/desktop-setup-modal';
import SecretApprovalDialog from '@src/components/secret-approval-dialog';
import { initNotificationListener } from '@src/store/use-notification-store';
import { SnifferProvider } from '@src/contexts/SnifferContext';
import { FloatingChatProvider } from '@src/components/floating-chat';
import { usePresenceReporter } from '@src/hooks/use-presence-reporter';
import { useBrowserContextReporter } from '@src/hooks/use-browser-context-reporter';
import { useUiCommandListener } from '@src/hooks/use-ui-command-listener';

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
    return null;
  };

  // Initialize notification listener (skills, hooks, etc.)
  useEffect(() => {
    const cleanup = initNotificationListener();
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

  useEffect(() => {
    const handleHubClientError = (msg: Record<string, unknown>) => {
      const method = String(msg.method ?? '').trim();
      const path = String(msg.path ?? '').trim();
      const statusCode = Number(msg.status_code ?? 0);
      const rawMessage = String(msg.message ?? '');
      const suppressedCount = Number(msg.suppressed_count ?? 0);

      if (suppressedCount > 0) {
        toast.warning('Hub errors suppressed', {
          description: `${suppressedCount} hub errors were suppressed in the current window.`,
        });
        return;
      }

      // /login has a dedicated handler in user-dropdown that shows a more
      // targeted toast (with friendly copy already produced by
      // ``_post_cloud_login`` server-side). Suppress the generic toast here
      // to avoid two near-identical popups on the same click.
      if (path === '/login' || path.endsWith('/login')) return;

      // Map raw transport / status signals to user-friendly copy. The raw
      // form ("POST /login -> 0: All connection attempts failed") reads as
      // a stack-trace; the categorized form below answers "what should I do
      // about it?" for the common cases.
      let title = 'Cloud error';
      let description = rawMessage;
      if (statusCode === 0) {
        title = 'Cloud is not available';
        description = "We couldn't reach the cloud service. Check your connection or try again in a moment.";
      } else if (statusCode === 401) {
        title = 'Cloud sign-in expired';
        description = 'Please sign in again to keep using cloud features.';
      } else if (statusCode === 403) {
        title = 'Cloud access denied';
        description = "You don't have permission for this action. Contact your admin if this seems wrong.";
      } else if (statusCode === 404) {
        title = 'Cloud resource not found';
        description = "We couldn't find what you were looking for on the cloud.";
      } else if (statusCode >= 500) {
        title = 'Cloud service is having trouble';
        description = 'The cloud service returned an error. Please try again in a moment.';
      } else if (statusCode >= 400) {
        title = 'Cloud request rejected';
        description = rawMessage || `The cloud rejected the request (${statusCode}).`;
      }

      toast.error(title, {
        description,
        // Stash technical detail in a footer so power users can still see it
        // without it being the headline.
        action: rawMessage
          ? { label: 'Detail', onClick: () => console.warn('[hub error]', { method, path, statusCode, rawMessage }) }
          : undefined,
      });
    };

    cloudManager.on('hub_client_error', handleHubClientError);
    return () => {
      cloudManager.off('hub_client_error', handleHubClientError);
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <CleanupModal />
        <GlobalEvents />
        <DesktopSetupModalHandler />
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
