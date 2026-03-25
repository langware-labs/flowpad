import { ActionInfo, connectionManager, dataContext, dataManager } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { useToast } from '@src/hooks/use-toast';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const CLAUDE_CODE_DOWNLOAD_URL = 'https://code.claude.com/docs/en/setup';

/** Reason passed via open-desktop-setup event detail when auth is missing */
export const DESKTOP_SETUP_REASON_AUTH_FAILURE = 'auth-failure';

interface DesktopSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** When true, shows a warning that Claude Code authentication failed */
  authFailure?: boolean;
}

export function DesktopSetupModal({ isOpen, onClose, authFailure }: DesktopSetupModalProps) {
  const [isScanning, setIsScanning] = useState(true);
  const [installedAgents, setInstalledAgents] = useState<string[]>([]);
  const [isOAuthInProgress, setIsOAuthInProgress] = useState(false);
  const [oauthState, setOauthState] = useState<string | null>(null);
  const authWindowRef = useRef<Window | null>(null);
  const oauthCompletedRef = useRef<boolean>(false);
  const { user } = useAuth();
  const { toast } = useToast();

  const isClaudeCodeInstalled = installedAgents.some((agent) => agent.toLowerCase().includes('claude code'));

  // Listen for LLM config WebSocket messages (OAuth status)
  useEffect(() => {
    if (!oauthState) return;

    const handleLlmConfigMessage = (message: {
      is_configured: boolean;
      auth_method: string;
      oauth_request_id?: string;
      status?: 'success' | 'error';
    }) => {
      if (oauthCompletedRef.current) return;

      const isOurRequest = message.oauth_request_id === oauthState;
      const isSuccessfulAnthropicOAuth =
        message.status === 'success' && message.auth_method === 'oauth' && message.is_configured;

      if (isOurRequest || isSuccessfulAnthropicOAuth) {
        oauthCompletedRef.current = true;

        if (message.status === 'success') {
          if (authWindowRef.current) {
            authWindowRef.current.close();
            authWindowRef.current = null;
          }
          toast({
            title: 'Success',
            description: 'Anthropic OAuth authentication completed successfully',
          });
          setIsOAuthInProgress(false);
          setOauthState(null);
          onClose();
        } else if (message.status === 'error' && isOurRequest) {
          if (authWindowRef.current) {
            authWindowRef.current.close();
            authWindowRef.current = null;
          }
          setIsOAuthInProgress(false);
          setOauthState(null);
          toast({
            title: 'Authentication Failed',
            description: 'OAuth authentication failed. Please try again.',
            variant: 'destructive',
            duration: 5000,
          });
        }
      }
    };

    connectionManager.on('on_llm_config_msg', handleLlmConfigMessage);

    return () => {
      connectionManager.off('on_llm_config_msg', handleLlmConfigMessage);
    };
  }, [oauthState, toast, onClose]);

  useEffect(() => {
    if (!isOpen) {
      setIsScanning(true);
      setOauthState(null);
      setIsOAuthInProgress(false);
      oauthCompletedRef.current = false;
      if (authWindowRef.current) {
        authWindowRef.current.close();
        authWindowRef.current = null;
      }
      return;
    }

    const timer = setTimeout(() => {
      const bootstrapInfo = dataContext.bootstrapInfo;
      const desktopInfo = bootstrapInfo?.desktop_info;
      const agents = (desktopInfo?.installed_agents || []) as string[];
      setInstalledAgents(agents);
      setIsScanning(false);
    }, 1500);

    return () => clearTimeout(timer);
  }, [isOpen]);

  const startOAuthFlow = async () => {
    if (isOAuthInProgress) return;

    if (!user?.typeId) {
      toast({
        title: 'Error',
        description: 'User not found. Please log in.',
        variant: 'destructive',
      });
      return;
    }

    oauthCompletedRef.current = false;
    setIsOAuthInProgress(true);

    try {
      const authActionInfo = new ActionInfo('oauth', user.typeId.type, user.typeId.id, 'GET');
      authActionInfo.subpath = 'anthropic/auth';
      authActionInfo.queryParameters = { desktop: 'true' };

      const authResponse = await dataManager.callAction<unknown, { url: string; port: number; state: string }>(
        authActionInfo,
      );

      if (!authResponse?.url || !authResponse?.state) {
        throw new Error('Failed to get OAuth authorization URL');
      }

      const { url, state } = authResponse;
      setOauthState(state);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const electronAPI = (window as any).electronAPI;
      if (electronAPI?.openExternal) {
        await electronAPI.openExternal(url);
      } else {
        const authWindow = window.open(url, '_blank', 'width=600,height=700');
        if (!authWindow) {
          throw new Error('Failed to open authorization window. Please allow popups.');
        }
        authWindowRef.current = authWindow;
      }

      const waitActionInfo = new ActionInfo('oauth', user.typeId.type, user.typeId.id, 'POST');
      waitActionInfo.subpath = 'anthropic/wait-callback';
      waitActionInfo.queryParameters = { state };

      dataManager
        .callAction<unknown, { message?: string }>(waitActionInfo)
        .then(() => {
          if (!oauthCompletedRef.current) {
            oauthCompletedRef.current = true;
            if (authWindowRef.current) {
              authWindowRef.current.close();
              authWindowRef.current = null;
            }
            toast({
              title: 'Success',
              description: 'Anthropic OAuth authentication completed successfully',
            });
            setIsOAuthInProgress(false);
            setOauthState(null);
            onClose();
          }
        })
        .catch((error) => {
          if (!oauthCompletedRef.current) {
            oauthCompletedRef.current = true;
            if (authWindowRef.current) {
              authWindowRef.current.close();
              authWindowRef.current = null;
            }
            setIsOAuthInProgress(false);
            setOauthState(null);

            let errorMessage = 'OAuth authentication failed. Please try again.';
            if (error instanceof Error) {
              if (error.message.includes('timeout')) {
                errorMessage = 'OAuth authentication timed out after 2 minutes. Please try again.';
              } else if (error.message.includes('State mismatch')) {
                errorMessage = 'OAuth authentication failed due to security validation error. Please try again.';
              } else if (error.message) {
                errorMessage = `OAuth authentication failed: ${error.message}`;
              }
            }

            toast({
              title: 'Authentication Failed',
              description: errorMessage,
              variant: 'destructive',
              duration: 5000,
            });
          }
        });
    } catch (error) {
      console.error('OAuth flow error:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to start OAuth flow',
        variant: 'destructive',
      });
      setIsOAuthInProgress(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-semibold">Desktop Setup</h2>
          <button onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground">
            ✕
          </button>
        </div>

        {authFailure && (
          <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
            Claude Code is not authenticated. Please log in to continue using AI features.
          </div>
        )}

        {isScanning ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Scanning...</span>
          </div>
        ) : !isClaudeCodeInstalled ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Claude Code is not installed. Please install it to continue.
            </p>
            <a
              href={CLAUDE_CODE_DOWNLOAD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-md border border-primary bg-primary/5 px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/10"
            >
              Download Claude Code
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        ) : (
          <div className="space-y-4">
            <button
              onClick={() => void startOAuthFlow()}
              disabled={isOAuthInProgress}
              className="w-full rounded-md border-2 border-primary bg-primary/5 p-4 text-left transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <div className="font-medium">Login with Anthropic</div>
              <div className="mt-1 text-sm text-muted-foreground">
                {isOAuthInProgress ? 'Waiting for authentication...' : 'Secure authentication via OAuth'}
              </div>
            </button>
            <p className="text-xs text-muted-foreground">
              If you prefer to connect via API key, you can do so in the CLI.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
