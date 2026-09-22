import { Agent, AgentChat, type AgentChatMessage, Deployment } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AgentAvatar } from '@src/components/agents/AgentAvatar';
import { badgeVariants } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Textarea } from '@src/components/ui/textarea';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

interface DeployedAgentChatPanelProps {
  agent: Agent;
  deployment: Deployment;
}

/** Where this viewer's conversation with one placement's chat is remembered (a per-viewer convenience). */
function conversationKey(deploymentId: string): string {
  return `flowpad.agent-chat.${deploymentId}`;
}

function remembered(deploymentId: string): string | null {
  try {
    return localStorage.getItem(conversationKey(deploymentId));
  } catch {
    return null;
  }
}

function remember(deploymentId: string, conversationId: string | null): void {
  try {
    if (conversationId) localStorage.setItem(conversationKey(deploymentId), conversationId);
    else localStorage.removeItem(conversationKey(deploymentId));
  } catch {
    // Storage is a convenience; a fresh conversation is the fallback.
  }
}

interface ShownMessage extends AgentChatMessage {
  tools?: string[];
}

/**
 * Chat with an agent on one placement — through that placement's `chat` endpoint.
 *
 * The same endpoint a hub page, a published app or any OpenAI client uses: this
 * computer answers a local placement, a cloud box answers its own (this backend
 * forwards to the hub, the hub to the box). "Open a session" is the owner's other
 * door: a process on that machine, for looking under the hood.
 */
export function DeployedAgentChatPanel({ agent, deployment }: DeployedAgentChatPanelProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [conversationId, setConversationId] = useState<string | null>(() => remembered(deployment.id));
  const [messages, setMessages] = useState<ShownMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const { data: chat, isLoading } = useQuery({
    queryKey: ['agent-chat', deployment.id],
    queryFn: () => AgentChat.forDeployment(deployment),
  });

  // A remembered conversation is shown as it stands.
  useEffect(() => {
    if (!chat || !conversationId) return;
    let live = true;
    chat
      .history(conversationId)
      .then((past) => live && setMessages(past))
      .catch(() => live && setMessages([]));
    return () => {
      live = false;
    };
  }, [chat, conversationId]);

  useEffect(() => () => abort.current?.abort(), []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!chat || !text || sending) return;
    setDraft('');
    setError(null);
    setSending(true);
    setMessages((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '', tools: [] }]);
    const controller = new AbortController();
    abort.current = controller;
    const patchReply = (patch: (reply: ShownMessage) => ShownMessage) =>
      setMessages((prev) => [...prev.slice(0, -1), patch(prev[prev.length - 1])]);
    try {
      for await (const event of chat.send(text, { conversationId, signal: controller.signal })) {
        if (event.type === 'text') patchReply((reply) => ({ ...reply, content: reply.content + event.text }));
        else if (event.type === 'tool') patchReply((reply) => ({ ...reply, tools: [...(reply.tools ?? []), event.name] }));
        else if (event.type === 'error') setError(event.message);
        else if (event.type === 'done' && event.conversationId) {
          setConversationId(event.conversationId);
          remember(deployment.id, event.conversationId);
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [chat, conversationId, deployment.id, draft, sending]);

  const newChat = () => {
    abort.current?.abort();
    remember(deployment.id, null);
    setConversationId(null);
    setMessages([]);
    setError(null);
  };

  const openSession = async () => {
    const receipt = await agent.useDeployment(deployment.id);
    void navigation.openShellProcess(receipt.process_id);
  };

  return (
    <div className="flex h-[32rem] min-h-0 flex-col border-t bg-background" data-testid="deployed-agent-chat">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <AgentAvatar agent={agent} className="h-8 w-8 text-xs" data-testid="deployed-agent-chat-avatar" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" data-testid="deployed-agent-chat-title">
            {agent.displayName}
          </div>
          <button
            type="button"
            className={badgeVariants({ variant: 'secondary', className: 'mt-0.5 cursor-pointer px-1.5 py-0 text-[10px]' })}
            onClick={() => navigation.openDock(agent.dockPointer)}
            data-testid="deployed-agent-chat-agent-link"
          >
            <Trans>Deployed agent</Trans>
          </button>
        </div>
        <Button variant="ghost" size="sm" onClick={newChat} data-testid="deployed-agent-chat-new">
          <Trans>New chat</Trans>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void openSession()} data-testid="deployed-agent-open-session">
          <Trans>Open a session on this machine</Trans>
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3" data-testid="deployed-agent-chat-messages">
        {isLoading ? null : !chat ? (
          <p className="text-sm text-muted-foreground" data-testid="deployed-agent-chat-unavailable">
            <Trans>This placement has no chat endpoint yet.</Trans>
          </p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>Send a message to this deployed agent.</Trans>
          </p>
        ) : (
          messages.map((message, index) => (
            <div
              key={index}
              className={message.role === 'user' ? 'ml-8 rounded-md bg-muted px-3 py-2 text-sm' : 'mr-8 text-sm'}
              data-testid={`deployed-agent-chat-${message.role}`}
            >
              {message.tools?.length ? (
                <div className="mb-1 text-[11px] text-muted-foreground">{message.tools.join(' · ')}</div>
              ) : null}
              <div className="whitespace-pre-wrap">
                {message.content || (message.role === 'assistant' && sending ? '…' : '')}
              </div>
            </div>
          ))
        )}
        {error && (
          <p className="text-sm text-destructive" data-testid="deployed-agent-chat-error">
            {error}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-end gap-2 border-t p-2">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={t`Message this deployed agent…`}
          className="min-h-[2.5rem] flex-1 resize-none text-sm"
          disabled={!chat}
          data-testid="deployed-agent-chat-input"
        />
        <Button onClick={() => void send()} disabled={!chat || sending || !draft.trim()} data-testid="deployed-agent-chat-send">
          <Trans>Send</Trans>
        </Button>
      </div>
    </div>
  );
}
