import { t } from '@lingui/core/macro';
import { useCopied } from '@src/components/ui/copy-button';
import { inboundParams } from '@src/navigation/inbound-link';
import { ActionInfo, BodyStatus, FlowMessage, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { Bot, Code, Sparkles, Terminal } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import './message-landing.css';
import { LOCAL_API_PREFIX, useOpenInFlowpad } from './useOpenFlowpad';
import { bounceToLoginOnce } from './login-bounce';
import WrongAccountPanel from './WrongAccountPanel';

const CopyIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
  </svg>
);

/** Hub messages carry a free-form metadata bag (task_title, spec_content, ...)
 *  that the OSS IFlowMessage interface does not declare — read it defensively. */
type MessageMetadata = {
  task_title?: string;
  spec_title?: string;
  sender_name?: string;
  spec_content?: string;
  task_id?: string;
};

const MessageLanding: React.FC = () => {
  const { messageId } = useParams<{ messageId: string }>();
  const [redirecting, setRedirecting] = useState(false);
  const { copied: planCopied, copy: copyPlan } = useCopied(2000);
  // Set when loading the message 401s after a login attempt (someone opened a
  // message link they have no access to). The invitation email/account mismatch
  // is handled server-side via the dedicated /wrong_account route.
  const [wrongAccount, setWrongAccount] = useState(false);

  const urlParams = useMemo(() => inboundParams(), []);
  const hasApiKey = urlParams.has('flowpad-api-key');

  const msgLoginAttemptKey = messageId ? `login-attempt-msg-${messageId}` : null;

  const typeId = !wrongAccount && messageId ? new TypeId(FlowMessage.type, messageId) : null;
  const { data: flowMessage, isLoading, notFound, error } = useEntity<FlowMessage>(typeId);

  useEffect(() => {
    // Already came back from login with an api-key but still 401 → permissions issue, not auth.
    if (error?.response?.status !== 401 || hasApiKey || !msgLoginAttemptKey) return;
    if (bounceToLoginOnce(msgLoginAttemptKey) === 'exhausted') setWrongAccount(true);
    else setRedirecting(true);
  }, [error, hasApiKey, msgLoginAttemptKey]);

  const openAction = useMemo(() => {
    if (!messageId) return null;
    return new ActionInfo('open', FlowMessage.type, messageId, 'GET');
  }, [messageId]);
  const openTargetPath = openAction ? `${LOCAL_API_PREFIX}${openAction.actionUrl}` : '';

  const handleOpenInFlowpad = useOpenInFlowpad(openTargetPath);

  // Show spinner until we have a definitive outcome (accepted + loaded, wrong account, or error).
  if (isLoading || redirecting || (!wrongAccount && !flowMessage && !notFound && !error)) {
    return (
      <div className="nl-center">
        <div className="nl-spinner" aria-label={t`Loading`} />
      </div>
    );
  }

  if (wrongAccount) {
    return (
      <WrongAccountPanel
        onBeforeSignIn={() => {
          if (msgLoginAttemptKey) sessionStorage.removeItem(msgLoginAttemptKey);
        }}
      />
    );
  }

  if (!flowMessage) {
    return (
      <div className="nl-center">
        <p className="nl-error">Message not found.</p>
      </div>
    );
  }

  const meta: MessageMetadata = (flowMessage as unknown as { metadata?: MessageMetadata }).metadata ?? {};
  const taskTitle = meta.task_title ?? meta.spec_title ?? 'Shared Task';
  const senderName = meta.sender_name ?? flowMessage.sender_name ?? 'Someone';
  const firstName = senderName.split(' ')[0];
  const specContent = meta.spec_content ?? '';
  const attachmentFilename = flowMessage.attachment_filename ?? '';
  // OSS BodyStatus has no FAILED member (NA/UPLOADING/READY), but legacy hub
  // rows may still carry 'failed' — compare through string to keep the state.
  const bodyFailed = (flowMessage.body_status as string | undefined) === 'failed';
  const bodyUploading = flowMessage.body_status === BodyStatus.UPLOADING;
  // Conversation shares (Scenario B) carry no task_id — render conversation
  // copy. Task shares keep the existing wording.
  const isConversation = !(meta.task_id ?? '').trim();

  const downloadUrl =
    attachmentFilename && messageId
      ? `${LOCAL_API_PREFIX}/graph/${FlowMessage.type}/${messageId}/fs/download/${encodeURIComponent(attachmentFilename)}`
      : '';

  const headerLabel = isConversation ? `Conversation with ${senderName}` : `Shared Task: ${taskTitle}`;
  const introCopy = isConversation ? (
    <>
      You received a new message from <strong>{senderName}</strong>.
    </>
  ) : (
    <>
      You received a new task from <strong>{senderName}</strong>.
    </>
  );
  const sectionLabel = isConversation
    ? 'View the conversation using one of these options:'
    : 'Start this task using one of these options:';
  const getAppPromoDesc = isConversation
    ? 'FlowPad is a free, open-source desktop app for collaborating on AI-powered conversations. Install it once to open messages like this on your machine.'
    : 'FlowPad is a free, open-source desktop app for collaborating on AI-powered tasks. Install it once to open tasks like this on your machine.';
  const downloadIntro = isConversation
    ? 'Download the bundle with the conversation.'
    : 'Download the bundle with the task details.';
  const downloadOutro = isConversation
    ? 'Upload it to FlowPad on any machine to open the conversation.'
    : 'Upload it to FlowPad on any machine to open the task.';

  return (
    <div className="nl-page">
      <div className="nl-header">
        <h1>{headerLabel}</h1>
      </div>
      <div className="nl-container">
        <div className="nl-intro">
          <p className="nl-task-from">{introCopy}</p>
        </div>

        {flowMessage.text && (
          <p className="nl-msg">
            <strong>{firstName}</strong> says: <em>&quot;{flowMessage.text}&quot;</em>
          </p>
        )}

        <p className="nl-section-label">{sectionLabel}</p>

        <div className="nl-options">
          <div className="nl-option">
            <h3 style={{ whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
              <span>Open with your favorite coding agent</span>
              {/* No-network stand-ins for the agent brand icons (Claude Code,
                  Codex, Cursor, Copilot) — lucide glyphs, approximate parity. */}
              <Bot className="nl-agent-icon" size={22} aria-label={t`Claude Code`} />
              <Terminal className="nl-agent-icon" size={22} aria-label={t`Codex`} />
              <Sparkles className="nl-agent-icon" size={22} aria-label={t`Cursor`} />
              <Code className="nl-agent-icon" size={22} aria-label={t`Copilot`} />
            </h3>
            <p>{getAppPromoDesc}</p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className="nl-btn" onClick={() => void handleOpenInFlowpad()}>
                Open in FlowPad
              </button>
              <a className="nl-btn" href="https://flowpad.ai/">
                Get FlowPad at flowpad.ai →
              </a>
            </div>
          </div>

          <div className="nl-option">
            <h3>📦 Open on any machine and use on-premise</h3>
            <p>{downloadIntro}</p>
            {bodyFailed ? (
              <p style={{ fontSize: 13, color: '#b00020' }}>
                The sender&apos;s upload didn&apos;t complete. Ask {firstName} to resend.
              </p>
            ) : bodyUploading ? (
              <p style={{ fontSize: 13, color: '#888' }}>
                {firstName} is still uploading the bundle. Try again in a moment.
              </p>
            ) : attachmentFilename && downloadUrl ? (
              <a className="nl-btn" href={downloadUrl} download={attachmentFilename}>
                Download {attachmentFilename}
              </a>
            ) : (
              <p style={{ fontSize: 13, color: '#888' }}>No bundle attached.</p>
            )}
            <p style={{ marginTop: 20 }}>{downloadOutro}</p>
          </div>
        </div>

        {specContent && (
          <div className="nl-plan-wrap">
            <div className="nl-plan-header">
              <span className="nl-plan-label">Plan</span>
              <button className="nl-copy-btn" onClick={() => void copyPlan(specContent)}>
                <CopyIcon />
                <span className="nl-copy-label">{planCopied ? 'Copied!' : 'Copy'}</span>
              </button>
            </div>
            <pre className="nl-plan-content">{specContent}</pre>
          </div>
        )}

        <div className="nl-footer">
          Sent via FlowPad &middot;{' '}
          <a href="https://flowpad.ai" style={{ color: '#aaa' }}>
            flowpad.ai
          </a>
        </div>
      </div>
    </div>
  );
};

export default MessageLanding;
