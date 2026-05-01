import { Avatar, AvatarFallback } from '@src/components/ui/avatar';
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
import { Cloud, LogIn, LogOut, Settings, User as UserIcon, Wrench } from 'lucide-react';

import { AccountInfo } from '@src/components/account/account-info';

import { trackEvent } from '@src/utils/analytics';
import { redirectToConsole } from '@src/utils/navigation';
import { Agent, cloudManager, dataContext, ExpansionRequest, navigator, Page, PAGE_TYPE, QueryFilter, QueryRequest, TypeId } from '@sdk';
import { useAuth, useConnectionStatus, useContext, useEntitiesQuery, useEntity, useWatch } from '@sdk/react/hooks';
import { SerializedElementNode, SerializedLexicalNode, SerializedTextNode } from 'lexical';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';

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

function cloudLoginTooltip(loggedIn: boolean): string {
  const url = cloudManager.cloudUrl;
  if (loggedIn) return url ? `Logged in to ${url}` : 'Logged in';
  return url ? `Not logged in (${url})` : 'Not logged in';
}

export function UserDropdown() {
  const { agentId } = useParams();
  const { user } = useAuth();
  const { isConnected } = useConnectionStatus();
  const { cloudLoginAvailable } = useContext();
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
    try {
      await cloudManager.login();
    } catch (e) {
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
            currentInstructionsPage = new Page({ title: 'Instructions', tags: [PAGE_TYPE.INSTRUCTIONS] });
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
        <DialogContent className="flex h-[520px] max-w-md flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle>Account Details</DialogTitle>
            <DialogDescription>View your account information and user details</DialogDescription>
          </DialogHeader>
          {user && <AccountInfo user={user} />}
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
                    title={!isConnected ? 'Service unavailable' : undefined}
                    data-testid="agent-page-user-avatar"
                  >
                    <AvatarFallback>
                      {user.name
                        ?.split(' ')
                        .map((n: string) => n[0])
                        .join('')
                        .toUpperCase() || '?'}
                    </AvatarFallback>
                  </Avatar>
                  {cloudLoginAvailable && (
                    <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-green-500 ring-2 ring-background" />
                  )}
                </div>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="top">{cloudLoginTooltip(cloudLoginAvailable)}</TooltipContent>
                  <DropdownMenuContent align="end">
                {isOwner && agentId && (
                  <>
                    <DropdownMenuItem onClick={() => setIsSettingsOpen(true)} className="cursor-pointer">
                      <Settings className="mr-2 h-4 w-4" />
                      Settings
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
                      Go to Console
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuItem
                  onClick={() => setIsAccountDialogOpen(true)}
                  className="cursor-pointer"
                  data-testid="agent-page-account-details-button"
                >
                  <UserIcon className="mr-2 h-4 w-4" />
                  Account Details
                </DropdownMenuItem>
                {cloudLoginAvailable ? (
                  <>
                    <DropdownMenuItem onClick={handleOpenFlowpadCloud} className="cursor-pointer">
                      <Cloud className="mr-2 h-4 w-4" />
                      Flowpad Cloud
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => void handleLogout()}
                      className="cursor-pointer text-red-500 focus:text-red-500"
                    >
                      <LogOut className="mr-2 h-4 w-4" />
                      Logout
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem
                    onClick={() => void handleCloudLogin()}
                    title={cloudManager.cloudUrl ? `Logging in to ${cloudManager.cloudUrl}` : undefined}
                    className="cursor-pointer"
                  >
                    <LogIn className="mr-2 h-4 w-4" />
                    Login
                  </DropdownMenuItem>
                )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </Tooltip>
            </TooltipProvider>
          </>
        ) : (
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
                  Login
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{cloudLoginTooltip(false)}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    </>
  );
}
