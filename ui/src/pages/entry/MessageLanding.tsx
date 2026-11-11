import { Trans, useLingui } from '@lingui/react/macro';
import { ActionInfo, BodyStatus, cloudManager, FlowMessage, isHubOnly, TypeId } from '@sdk';
import { useAuth, useEntity } from '@sdk/react/hooks';
import { Loader2 } from 'lucide-react';
import React, { useMemo } from 'react';
import { useParams } from 'react-router';
import flowpadLogo from '@src/assets/logo.png';
import { Avatar, AvatarFallback, AvatarImage } from '@src/components/ui/avatar';
import { Button } from '@src/components/ui/button';
import { useCopied } from '@src/components/ui/copy-button';
import { inboundParams } from '@src/navigation/inbound-link';
import { bounceToLoginOnce } from './login-bounce';
import claudeMark from '../../../../flow_sdk/server/icons/brands/assets/claude.svg';
import codexMark from '../../../../flow_sdk/server/icons/brands/assets/codex.svg';
import copilotMark from '../../../../flow_sdk/server/icons/brands/assets/copilot.svg';
import opencodeMark from '../../../../flow_sdk/server/icons/brands/assets/opencode.svg';
import { OpenInFlowpadActions } from './OpenInFlowpadActions';
import { LOCAL_API_PREFIX } from './useOpenFlowpad';
import WrongAccountPanel from './WrongAccountPanel';

/** Hub messages carry a free-form metadata bag (task_title, spec_content, ...)
 *  that the OSS IFlowMessage interface does not declare — read it defensively. */
type MessageMetadata = {
  task_title?: string;
  spec_title?: string;
  sender_name?: string;
  spec_content?: string;
  task_id?: string;
};

const initialsOf = (name: string) =>
  name
    .split(/[\s._@-]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || '?';

/** Where you are, and who you are signed in as (or Log in). */
function LandingTopBar({ from, onLogIn }: { from?: string; onLogIn?: () => void }) {
  const { currentUser } = useAuth();
  const name = currentUser?.name || currentUser?.email || '';
  const picture = currentUser?.picture && /^(https?:|data:|\/)/.test(currentUser.picture) ? currentUser.picture : '';
  return (
    <header className="flex h-14 items-center justify-between border-b px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <img src={flowpadLogo} alt="FlowPad" className="h-4 dark:brightness-0 dark:invert" />
        <span className="truncate text-xs text-muted-foreground">
          {from ? <Trans>› Messages › from {from}</Trans> : <Trans>› Messages</Trans>}
        </span>
      </div>
      {onLogIn ? (
        <Button size="sm" variant="outline" onClick={onLogIn} data-testid="landing-log-in">
          <Trans>Log in</Trans>
        </Button>
      ) : name ? (
        <div className="flex items-center gap-2" data-testid="landing-profile">
          <span className="hidden text-xs text-muted-foreground sm:inline">{name}</span>
          <Avatar className="h-8 w-8">
            {picture && <AvatarImage src={picture} alt={name} />}
            <AvatarFallback className="text-xs">{initialsOf(name)}</AvatarFallback>
          </Avatar>
        </div>
      ) : null}
    </header>
  );
}

/** The coding agents FlowPad opens a message with — the vendors' own marks (the brands icon pack's files),
 *  bundled: this page also renders on the hub, which serves no icon packs. */
const AGENT_MARKS: [string, string][] = [
  [claudeMark, 'Claude Code'],
  [codexMark, 'Codex'],
  [copilotMark, 'GitHub Copilot'],
  [opencodeMark, 'OpenCode'],
];

const MessageLanding: React.FC = () => {
  const { t } = useLingui();
  const { messageId } = useParams<{ messageId: string }>();
  const { copied: planCopied, copy: copyPlan } = useCopied(2000);
  const hasApiKey = useMemo(() => inboundParams().has('flowpad-api-key'), []);
  const loginKey = messageId ? `login-attempt-msg-${messageId}` : null;

  const typeId = messageId ? new TypeId(FlowMessage.type, messageId) : null;
  const { data: flowMessage, isLoading, notFound, error } = useEntity<FlowMessage>(typeId);
  const status = error?.response?.status;
  const unauthorized = status === 401;
  // Signed in as someone who may not see this message: the hub answers 403, or a 401
  // comes back after a sign-in round trip.
  const wrongAccount =
    status === 403 || (unauthorized && !hasApiKey && !!loginKey && !!sessionStorage.getItem(loginKey));
  // On the hub this page renders signed out (`anonymous-entry.ts`), so it owns its sign-in, from the
  // click: a popup keeps this tab, then the page reloads as the signed-in user.
  const logIn = () =>
    isHubOnly() ? void cloudManager.login({ refresh: 'reload' }) : loginKey && bounceToLoginOnce(loginKey);

  const shell = (body: React.ReactNode, from?: string, signedOut = false) => (
    <div className="flex min-h-screen flex-col bg-background text-foreground" data-testid="message-landing">
      <LandingTopBar from={from} onLogIn={signedOut ? logIn : undefined} />
      <main className="flex flex-1 items-start justify-center px-4 py-10 sm:items-center">
        <div className="w-full max-w-xl">{body}</div>
      </main>
    </div>
  );

  if (wrongAccount) {
    return (
      <WrongAccountPanel
        reason={status === 403 ? 'no-access' : 'wrong-account'}
        onBeforeSignIn={() => {
          if (loginKey) sessionStorage.removeItem(loginKey);
        }}
      />
    );
  }
  if (unauthorized && !hasApiKey) {
    return shell(
      <div className="rounded-xl border bg-card p-6 shadow-sm sm:p-8" data-testid="landing-signed-out">
        <h1 className="text-2xl font-semibold">
          <Trans>You have a message</Trans>
        </h1>
        <p className="mt-6 rounded-lg border bg-muted/40 p-6 text-sm text-muted-foreground">
          <Trans>Log in to read the message here — or open it in FlowPad.</Trans>
        </p>
        <div className="mt-6 flex justify-center">
          <Button onClick={logIn}>
            <Trans>Log in</Trans>
          </Button>
        </div>
      </div>,
      undefined,
      true,
    );
  }
  if (isLoading || (!flowMessage && !notFound && !error)) {
    return shell(
      <div className="flex justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label={t`Loading`} />
      </div>,
    );
  }
  if (!flowMessage || !messageId) {
    return shell(
      <p className="text-center text-sm text-destructive">
        <Trans>Message not found.</Trans>
      </p>,
    );
  }

  const meta: MessageMetadata = (flowMessage as unknown as { metadata?: MessageMetadata }).metadata ?? {};
  const senderName = meta.sender_name ?? flowMessage.sender_name ?? t`Someone`;
  const specContent = meta.spec_content ?? '';
  const attachmentFilename = flowMessage.attachment_filename ?? '';
  // OSS BodyStatus has no FAILED member (NA/UPLOADING/READY), but legacy hub
  // rows may still carry 'failed' — compare through string to keep the state.
  const bodyFailed = (flowMessage.body_status as string | undefined) === 'failed';
  const bodyUploading = flowMessage.body_status === BodyStatus.UPLOADING;
  const openTargetPath = `${LOCAL_API_PREFIX}${new ActionInfo('open', FlowMessage.type, messageId, 'GET').actionUrl}`;
  const downloadUrl = attachmentFilename
    ? `${LOCAL_API_PREFIX}/graph/${FlowMessage.type}/${messageId}/fs/download/${encodeURIComponent(attachmentFilename)}`
    : '';
  const isConversation = !(meta.task_id ?? '').trim();
  const taskTitle = meta.task_title ?? meta.spec_title ?? t`Shared Task`;
  const firstName = senderName.split(' ')[0];

  return (
    <div className="nl-page" data-testid="message-landing">
      <div className="nl-header">
        <h1 data-testid="landing-title">
          {isConversation ? <Trans>Conversation with {senderName}</Trans> : <Trans>Shared Task: {taskTitle}</Trans>}
        </h1>
      </div>
      <div className="nl-container">
        <div className="nl-intro">
          <p className="nl-task-from">
            {isConversation ? (
              <Trans>
                You received a new message from <strong>{senderName}</strong>.
              </Trans>
            ) : (
              <Trans>
                You received a new task from <strong>{senderName}</strong>.
              </Trans>
            )}
          </p>
        </div>

        {flowMessage.text && (
          <p className="nl-msg" data-testid="landing-preview">
            <strong>{firstName}</strong> <Trans>says:</Trans> <em>&quot;{flowMessage.text}&quot;</em>
          </p>
        )}

        <p className="nl-section-label">
          {isConversation ? (
            <Trans>View the conversation using one of these options:</Trans>
          ) : (
            <Trans>Start this task using one of these options:</Trans>
          )}
        </p>

        <div className="nl-options">
          <div className="nl-option">
            <h3 className="nl-agents">
              <span>
                <Trans>Open with your favorite coding agent</Trans>
              </span>
              {AGENT_MARKS.map(([src, name]) => (
                <img key={name} src={src} className="nl-agent-icon" width={20} height={20} alt={name} title={name} />
              ))}
            </h3>
            <p>
              {isConversation ? (
                <Trans>
                  FlowPad is a free, open-source desktop app for collaborating on AI-powered conversations. Install it
                  once to open messages like this on your machine.
                </Trans>
              ) : (
                <Trans>
                  FlowPad is a free, open-source desktop app for collaborating on AI-powered tasks. Install it once to
                  open tasks like this on your machine.
                </Trans>
              )}
            </p>
            <OpenInFlowpadActions openTargetPath={openTargetPath} showConnection />
          </div>

          <div className="nl-option">
            <h3>
              📦 <Trans>Open on any machine and use on-premise</Trans>
            </h3>
            <p>
              {isConversation ? (
                <Trans>Download the bundle with the conversation.</Trans>
              ) : (
                <Trans>Download the bundle with the task details.</Trans>
              )}
            </p>
            {bodyFailed ? (
              <p className="nl-bundle-note nl-bundle-failed">
                <Trans>The sender&apos;s upload didn&apos;t complete. Ask {firstName} to resend.</Trans>
              </p>
            ) : bodyUploading ? (
              <p className="nl-bundle-note">
                <Trans>{firstName} is still uploading the bundle. Try again in a moment.</Trans>
              </p>
            ) : downloadUrl ? (
              <a className="nl-btn" href={downloadUrl} download={attachmentFilename} data-testid="landing-download">
                <Trans>Download {attachmentFilename}</Trans>
              </a>
            ) : (
              <p className="nl-bundle-note">
                <Trans>No bundle attached.</Trans>
              </p>
            )}
            <p className="nl-after">
              {isConversation ? (
                <Trans>Upload it to FlowPad on any machine to open the conversation.</Trans>
              ) : (
                <Trans>Upload it to FlowPad on any machine to open the task.</Trans>
              )}
            </p>
          </div>
        </div>

        {specContent && (
          <div className="nl-plan-wrap">
            <div className="nl-plan-header">
              <span className="nl-plan-label">
                <Trans>Plan</Trans>
              </span>
              <button className="nl-copy-btn" onClick={() => void copyPlan(specContent)}>
                <span className="nl-copy-label">{planCopied ? <Trans>Copied!</Trans> : <Trans>Copy</Trans>}</span>
              </button>
            </div>
            <pre className="nl-plan-content">{specContent}</pre>
          </div>
        )}

        <div className="nl-footer">
          <Trans>Sent via FlowPad</Trans> &middot; <a href="https://flowpad.ai">flowpad.ai</a>
        </div>
      </div>
    </div>
  );
};

export default MessageLanding;
