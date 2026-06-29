import { Avatar, AvatarFallback, AvatarImage } from '@src/components/ui/avatar';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { SettingsPane } from '@src/components/ui/settings-pane';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { Cloud, HelpCircle, LogIn, LogOut, Settings, User as UserIcon, Wrench } from 'lucide-react';
import { notify } from '@src/notifications';

import { AccountInfo } from '@src/components/account/account-info';

import { trackEvent } from '@src/utils/analytics';
import { redirectToConsole } from '@src/utils/navigation';
import { Agent, cloudManager, dataContext, ExpansionRequest, HubConnectionStatus, HubLoginStatus, navigator, Page, PAGE_TYPE, QueryFilter, QueryRequest, TypeId } from '@sdk';
import { useAuth, useCloudStatus, useConnectionStatus, useContext, useEntitiesQuery, useEntity, useWatch } from '@sdk/react/hooks';
import { usePrivacyMode } from '@src/hooks/use-privacy-mode';
import { guardCloudAction } from '@src/services/privacy-guard';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { SerializedElementNode, SerializedLexicalNode, SerializedTextNode } from 'lexical';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { Trans, useLingui } from '@lingui/react/macro';

function isDefaultEmptyLexicalContent(content: { root: { children: SerializedLexicalNode[] } }): boolean {
  if (content.root?.children?.length !== 1) return false;

  const firstChild = content.root.children[0];
  if (firstChild.type !== 'paragraph') return false;

  const paragraphNode = firstChild as SerializedElementNode;
  if (paragraphNode.children?.length !== 1) return false;

  const textNode = paragraphNode.children[0] as SerializedTextNode;
  return textNode.type === 'text' && textNode.text === '';
}

function extractTextFromAnyNode(node: SerializedLexicalNode): string {
  if (!node) return '';

  if (node.type === 'text') {
    return (node as SerializedTextNode).text || '';
  }

  if (node.type === 'list') {
    const listNode = node as SerializedElementNode & { listType?: string };
    const listType = listNode.listType || 'bullet';
    return (listNode.children || [])
      .map((item: SerializedLexicalNode, index: number) => {
        const itemText = extractTextFromAnyNode(item);
        switch (listType) {
          case 'number':
            return `${index + 1}. ${itemText}`;
          case 'check': {
            const checkbox = (item as SerializedLexicalNode & { checked?: boolean }).checked ? '[x]' : '[ ]';
            return `${checkbox} ${itemText}`;
          }
          default:
            return `- ${itemText}`;
        }
      })
      .join('\n');
  }

  // Handle list items, paragraphs, and other container nodes
  const elementNode = node as SerializedElementNode;
  if (Array.isArray(elementNode.children)) {
    return elementNode.children.map(extractTextFromAnyNode).join('');
  }

  return '';
}

function extractRulesFromLexical(content: { root: { children: SerializedElementNode[] } }): string {
  if (isDefaultEmptyLexicalContent(content)) {
    return '';
  }

  const rootChildren = content.root?.children || [];
  return rootChildren.map(extractTextFromAnyNode).filter(Boolean).join('\n\n');
}

function parseRulesContent(rawContent: string): string {
  try {
    return extractRulesFromLexical(JSON.parse(rawContent));
  } catch {
    return rawContent;
  }
}

const agentQuery = new ExpansionRequest({ expand: ['permissions'] });
const instructionsQueryFilter = new QueryFilter({
  expand: ['blobs', 'permissions'],
  match: {
    op: '$IN',
    operands: [
      PAGE_TYPE.INSTRUCTIONS,
      {
        op: '$PROP',
        operands: ['tags'],
      },
    ],
  },
});

function cloudConnectionLabel(status: HubConnectionStatus): string {
  switch (status) {
    case 'verified':       return 'connection verified';
    case 'connected':      return 'connected';
    case 'connecting':     return 'connecting';
    case 'auth_rejected':  return 'connection rejected';
    case 'error':          return 'connection error';
    case 'disconnected':   return 'not connected';
  }
}

function cloudLoginTooltip(
  loginStatus: HubLoginStatus,
  connectionStatus: HubConnectionStatus,
  cloudUrl: string,
  email?: string,
): string {
  if (loginStatus === 'logged_in') {
    const conn = cloudConnectionLabel(connectionStatus);
    if (email && cloudUrl) return `${email} is logged into ${cloudUrl} (${conn})`;
    if (email) return `${email} is logged in (${conn})`;
    return cloudUrl ? `Logged in to ${cloudUrl} (${conn})` : `Logged in (${conn})`;
  }
  if (loginStatus === 'logging_in') return cloudUrl ? `Signing in to ${cloudUrl}…` : 'Signing in…';
  if (loginStatus === 'login_failed') return 'Login failed';
  return cloudUrl ? `Not logged in (${cloudUrl})` : 'Not logged in';
}

/**
 * Avatar status dot. Encodes the (login, connection) tuple:
 *   logged_in + verified/connected → green
 *   logged_in + connecting → amber spinner (rendered as pulse)
 *   logged_in + auth_rejected/error/disconnected → amber/red dot
 *   logged_out → no dot
 */
function statusDotClass(login: HubLoginStatus, connection: HubConnectionStatus): string | null {
  if (login !== 'logged_in') return null;
  if (connection === 'verified' || connection === 'connected') {
    return 'bg-green-500';
  }
  if (connection === 'connecting') {
    return 'bg-amber-400 animate-pulse';
  }
  if (connection === 'auth_rejected') {
    return 'bg-red-500';
  }
  // error | disconnected
  return 'bg-amber-500';
}

export function UserDropdown() {
  const { t } = useLingui();
  const { agentId } = useParams();
  const { user, currentUser } = useAuth();
  const { isConnected } = useConnectionStatus();
  const { cloudLoginAvailable } = useContext();
  // In Local (private) data-privacy mode the cloud is off-limits, so no login
  // affordance is shown at all.
  const { isLocal } = usePrivacyMode();
  // App-settings dock viewer — relocated here from the footer (which now hosts
  // the data-privacy control in place of the old gear).
  const { navigation } = useDockNavigation();
  const { login, connection, cloudUrl } = useCloudStatus();
  const dotClass = statusDotClass(login.status, connection.status);
  // Logged out of cloud → identity is unknown, so fall back to a neutral
  // question-mark glyph rather than the local user's initials (a name we can't
  // actually vouch for). When logged in, derive up-to-2-char initials.
  const avatarInitials = cloudLoginAvailable
    ? (currentUser?.name || currentUser?.email?.split('@')[0] || '?')
        .split(/[\s._-]+/)
        .map((n: string) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : null;
  const agentTypeId = useMemo(() => (agentId ? new TypeId(Agent.type, agentId) : null), [agentId]);
  const { data: agent } = useEntity<Agent>(agentTypeId, {
    query: user ? agentQuery : new ExpansionRequest({}),
  });
  const isOwner = useMemo(() => agent?.ImOwner || false, [agent]);
  const instructionsScope = useMemo(() => (agentTypeId ? [agentTypeId] : []), [agentTypeId]);
  const instructionsRequest = useMemo(
    () =>
      new QueryRequest({
        type: Page.type,
        query: instructionsQueryFilter,
        scope: instructionsScope,
        name: 'UserDropdown-instructions',
      }),
    [instructionsScope],
  );
  const { data: instructionsPages } = useEntitiesQuery<Page>(instructionsRequest, {
    enabled: isOwner && instructionsScope.length > 0,
  });
  const instructionsPage = useMemo(() => instructionsPages?.[0], [instructionsPages]);
  const instructionsPageTypeId = useMemo(() => instructionsPage?.typeId, [instructionsPage]);

  // Prevent unnecessary watch updates by stabilizing the watch condition
  const shouldWatch = useMemo(() => isOwner && !!instructionsPageTypeId, [isOwner, instructionsPageTypeId]);
  useWatch(shouldWatch ? instructionsPageTypeId || null : null, shouldWatch);
  const rules = useMemo(
    () => (instructionsPage?.raw_content ? parseRulesContent(instructionsPage.raw_content) : ''),
    [instructionsPage?.raw_content],
  );

  const handleLogout = useCallback(async () => {
    try {
      await dataContext.cloudLogout();
    } catch (e) {
      console.error('[Logout] Failed:', e);
    }
  }, []);

  const handleCloudLogin = useCallback(async () => {
    // Hidden in Local mode (below), but route through the single guard too so
    // every login entry point shares one defensive seam + standardized notice.
    if (!guardCloudAction('login')) return;
    try {
      await cloudManager.login();
    } catch (e) {
      // Surface as a Sonner toast immediately so the user gets a visible
      // popup even if the hub-side hub_client_error WS broadcast didn't
      // make it through (e.g. WS still reconnecting). The error message
      // is already user-friendly — produced server-side in
      // ``flow_sdk/cli/auth/cloud_login.py::_post_cloud_login``.
      const message = e instanceof Error ? e.message : 'Cloud sign-in failed.';
      // Categorize for the toast title so the user immediately knows the
      // KIND of failure; description carries the specific copy.
      let title = 'Cloud sign-in failed';
      let description = message;
      if (/cloud is not available/i.test(message)) {
        title = 'Cloud is not available';
        description = message.replace(/^cloud is not available\.?\s*/i, '');
      } else if (/invalid email or password|invalid credentials/i.test(message)) {
        title = 'Invalid credentials';
        description = message;
      } else if (/access denied/i.test(message)) {
        title = 'Cloud access denied';
        description = message;
      } else if (/not configured/i.test(message)) {
        title = 'Cloud is not configured';
        description = message;
      }
      notify.error({ title, message: description });
      console.error('[Cloud Login] Failed:', e);
    }
  }, []);

  const handleOpenFlowpadCloud = useCallback(() => {
    window.open('https://app.flowpad.ai', '_blank', 'noopener,noreferrer');
  }, []);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAccountDialogOpen, setIsAccountDialogOpen] = useState(false);

  useEffect(() => {
    const handler = () => setIsAccountDialogOpen(false);
    window.addEventListener('close-account-dialog', handler);
    return () => window.removeEventListener('close-account-dialog', handler);
  }, []);

  useEffect(() => {
    void cloudManager.refreshStatus();
  }, []);

  const handleSaveRules = useCallback(
    (newRules: string) => {
      if (!user || !isOwner || !agent) {
        return;
      }

      console.log('Saving new rules:', newRules);

      void (async () => {
        try {
          let currentInstructionsPage = instructionsPage;
          if (!currentInstructionsPage) {
            console.log('No page found, creating new one');
            currentInstructionsPage = new Page({ title: t`Instructions`, tags: [PAGE_TYPE.INSTRUCTIONS] });
            await currentInstructionsPage.save([agent.typeId]);
            // Get the chatbot to call ingest
            await agent.ingest([], [], [], [currentInstructionsPage.typeId]);
          }

          // Format the content as Lexical editor JSON
          const lexicalContent = {
            root: {
              children: [
                {
                  children: [
                    {
                      detail: 0,
                      format: 0,
                      mode: 'normal',
                      style: '',
                      text: newRules,
                      type: 'text',
                      version: 1,
                    },
                  ],
                  direction: 'ltr',
                  format: '',
                  indent: 0,
                  type: 'paragraph',
                  version: 1,
                },
              ],
              direction: 'ltr',
              format: '',
              indent: 0,
              type: 'root',
              version: 1,
            },
          };

          // Set raw_content with properly formatted JSON
          currentInstructionsPage.raw_content = JSON.stringify(lexicalContent);
          await currentInstructionsPage.save();
          console.log('Rules saved successfully');
        } catch (error) {
          console.error('Error saving rules:', error);
        }
      })();
    },
    [user, isOwner, agent, instructionsPage],
  );

  return (
    <>
      <SettingsPane
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onSave={handleSaveRules}
        initialRules={rules}
      />

      <Dialog open={isAccountDialogOpen} onOpenChange={setIsAccountDialogOpen}>
        <DialogContent className="flex h-[520px] max-w-lg flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle><Trans>Settings</Trans></DialogTitle>
            <DialogDescription><Trans>Configure your account, app preferences, and notifications</Trans></DialogDescription>
          </DialogHeader>
          {currentUser && <AccountInfo user={currentUser} />}
        </DialogContent>
      </Dialog>

      <div className="flex flex-col items-center gap-2">
        {user ? (
          <>
            <TooltipProvider>
              <Tooltip>
                <DropdownMenu>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                <div className="relative cursor-pointer">
                  <Avatar
                    className={`h-8 w-8 transition-opacity hover:opacity-80${!isConnected ? ' ring-2 ring-orange-500 shadow-[0_0_8px_2px_rgba(249,115,22,0.6)] animate-pulse' : ''}`}
                    title={!isConnected ? t`Service unavailable` : undefined}
                    data-testid="agent-page-user-avatar"
                  >
                    {cloudLoginAvailable && currentUser?.picture && (
                      <AvatarImage src={currentUser.picture} alt={currentUser.name ?? currentUser.email ?? ''} />
                    )}
                    <AvatarFallback>
                      {avatarInitials ?? <HelpCircle className="h-5 w-5 text-muted-foreground" />}
                    </AvatarFallback>
                  </Avatar>
                  {dotClass && (
                    <span className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full ring-2 ring-background ${dotClass}`} />
                  )}
                </div>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="top">{cloudLoginTooltip(login.status, connection.status, cloudUrl, currentUser?.email)}</TooltipContent>
                  <DropdownMenuContent align="end">
                {isOwner && agentId && (
                  <>
                    <DropdownMenuItem onClick={() => setIsSettingsOpen(true)} className="cursor-pointer">
                      <Settings className="mr-2 h-4 w-4" />
                      <Trans>Settings</Trans>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => redirectToConsole(agentId)}
                      onMouseDown={(e) => {
                        if (e.button === 1) {
                          e.preventDefault();
                          redirectToConsole(agentId, true);
                        }
                      }}
                      className="cursor-pointer"
                    >
                      <Wrench className="mr-2 h-4 w-4" />
                      <Trans>Go to Console</Trans>
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuItem
                  onClick={() => navigation.openSettings()}
                  className="cursor-pointer"
                  data-testid="app-settings-button"
                >
                  <Settings className="mr-2 h-4 w-4" />
                  <Trans>App Settings</Trans>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setIsAccountDialogOpen(true)}
                  className="cursor-pointer"
                  data-testid="agent-page-account-details-button"
                >
                  <UserIcon className="mr-2 h-4 w-4" />
                  <Trans>Settings</Trans>
                </DropdownMenuItem>
                {/* Logout below = *cloud* logout. A local-only user (no cloud
                    login) is anonymous — the Login branch should fire. If you
                    see Logout without being cloud-logged-in, cloudLoginAvailable
                    is stale (cloudManager state didn't match /cloud/status). */}
                {cloudLoginAvailable ? (
                  <>
                    <DropdownMenuItem onClick={handleOpenFlowpadCloud} className="cursor-pointer">
                      <Cloud className="mr-2 h-4 w-4" />
                      <Trans>Flowpad Cloud</Trans>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => void handleLogout()}
                      className="cursor-pointer text-red-500 focus:text-red-500"
                    >
                      <LogOut className="mr-2 h-4 w-4" />
                      <Trans>Logout</Trans>
                    </DropdownMenuItem>
                  </>
                ) : isLocal ? null : (
                  <DropdownMenuItem
                    onClick={() => void handleCloudLogin()}
                    title={cloudManager.cloudUrl ? `Logging in to ${cloudManager.cloudUrl}` : undefined}
                    className="cursor-pointer"
                  >
                    <LogIn className="mr-2 h-4 w-4" />
                    <Trans>Login</Trans>
                  </DropdownMenuItem>
                )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </Tooltip>
            </TooltipProvider>
          </>
        ) : isLocal ? null : (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => {
                    trackEvent({ event: 'login_clicked', event_source: 'page_header' });
                    navigator.navigateToLogin();
                  }}
                >
                  <Trans>Login</Trans>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{cloudLoginTooltip('logged_out', 'disconnected', cloudUrl)}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    </>
  );
}
