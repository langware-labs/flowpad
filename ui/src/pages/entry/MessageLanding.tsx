import { Trans, useLingui } from '@lingui/react/macro';
import { ActionInfo, BodyStatus, cloudManager, FlowMessage, isHubOnly, TypeId } from '@sdk';
import { useAuth, useEntity } from '@sdk/react/hooks';
import { Loader2, RotateCw } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import flowpadLogo from '@src/assets/logo.png';
import { Avatar, AvatarFallback, AvatarImage } from '@src/components/ui/avatar';
import { Button } from '@src/components/ui/button';
import { useCopied } from '@src/components/ui/copy-button';
import { inboundParams } from '@src/navigation/inbound-link';
import { bounceToLoginOnce } from './login-bounce';
import { openOnDesktop, useDesktopPresence } from './use-desktop-presence';
import { LOCAL_API_PREFIX, useOpenInFlowpad } from './useOpenFlowpad';
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

/** The one call to action: checked against the hub first, then Open (online) or offline + Open | Download. */
function OpenArea({ messageId, download }: { messageId: string; download: (offline: boolean) => React.ReactNode }) {
  const { presence, recheck } = useDesktopPresence(true);
  const [busy, setBusy] = useState(false);
  const [wentOffline, setWentOffline] = useState(false);
  const launch = useOpenInFlowpad(
    `${LOCAL_API_PREFIX}${new ActionInfo('open', FlowMessage.type, messageId, 'GET').actionUrl}`,
  );
  const offline = presence === 'offline' || wentOffline;

  if (presence === 'checking') {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="landing-checking">
        <Loader2 className="h-4 w-4 animate-spin" />
        <Trans>Checking FlowPad status…</Trans>
      </p>
    );
  }
  if (offline) {
    return (
      <div className="flex flex-col items-center gap-2" data-testid="landing-offline">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Trans>FlowPad is offline</Trans>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => {
              setWentOffline(false);
              recheck();
            }}
            data-testid="landing-check-again"
          >
            <RotateCw className="h-3.5 w-3.5" />
            <Trans>Check again</Trans>
          </Button>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <button type="button" className="underline" onClick={() => void launch()} data-testid="landing-launch">
            <Trans>Open</Trans>
          </button>
          <span className="text-muted-foreground">|</span>
          {download(true)}
        </div>
      </div>
    );
  }
  return (
    <div className="flex w-full flex-col items-center gap-2" data-testid="landing-online">
      <Button
        className="h-12 w-full bg-brand text-base font-semibold text-brand-foreground hover:bg-brand/90"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void openOnDesktop(messageId)
            .then((delivered) => setWentOffline(delivered === 0))
            .catch(() => setWentOffline(true))
            .finally(() => setBusy(false));
        }}
        data-testid="landing-open"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        <Trans>Open in FlowPad</Trans>
      </Button>
      <span className="text-xs text-muted-foreground">{download(false)}</span>
    </div>
  );
}

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
  const downloadUrl = attachmentFilename
    ? `${LOCAL_API_PREFIX}/graph/${FlowMessage.type}/${messageId}/fs/download/${encodeURIComponent(attachmentFilename)}`
    : '';
  const download = (offline: boolean) =>
    bodyFailed ? (
      <span className="text-destructive">
        <Trans>The upload didn't complete — ask {senderName} to resend.</Trans>
      </span>
    ) : bodyUploading ? (
      <span>
        <Trans>{senderName} is still uploading — try again in a moment.</Trans>
      </span>
    ) : downloadUrl ? (
      <a
        className={offline ? 'underline' : 'underline-offset-2 hover:underline'}
        href={downloadUrl}
        download={attachmentFilename}
        data-testid="landing-download"
      >
        {offline ? <Trans>Download</Trans> : <Trans>or download the message (.flowmsg)</Trans>}
      </a>
    ) : null;

  return shell(
    <div className="rounded-xl border bg-card p-6 shadow-sm sm:p-8">
      <h1 className="text-2xl font-semibold" data-testid="landing-title">
        <Trans>{senderName} sent you a message</Trans>
      </h1>
      {flowMessage.text && (
        <div className="mt-6 flex gap-3 rounded-lg border bg-muted/40 p-4 sm:p-6" data-testid="landing-preview">
          <Avatar className="h-8 w-8 shrink-0">
            <AvatarFallback className="text-xs">{initialsOf(senderName)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="text-sm font-semibold">{senderName}</div>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{flowMessage.text}</p>
            {attachmentFilename && (
              <span className="mt-2 inline-block rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                {attachmentFilename}
              </span>
            )}
          </div>
        </div>
      )}
      {specContent && (
        <div className="mt-6 rounded-lg border">
          <div className="flex items-center justify-between border-b px-4 py-2 text-xs text-muted-foreground">
            <Trans>Plan</Trans>
            <button type="button" onClick={() => void copyPlan(specContent)}>
              {planCopied ? <Trans>Copied!</Trans> : <Trans>Copy</Trans>}
            </button>
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-4 text-xs">{specContent}</pre>
        </div>
      )}
      <div className="mt-6 flex justify-center">
        <OpenArea messageId={messageId} download={download} />
      </div>
    </div>,
    senderName,
  );
};

export default MessageLanding;
