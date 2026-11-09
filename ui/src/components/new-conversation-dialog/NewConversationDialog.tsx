import { isHubOnly } from '@src/navigation/hub-runtime';
import { Trans, useLingui } from '@lingui/react/macro';
import { ConversationParticipant, hasRemoteParticipant } from '@sdk';
import type { AssetDescriptor, ConversationSendPayload } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { useProjects } from '@src/hooks/use-projects';
import { useSendToConversation, type SendTarget } from '@src/hooks/use-send-to-conversation';
import { useAutoTitle } from '@src/hooks/use-auto-title';
import { AutofillInput } from '@src/components/ui/autofill-input';
import { Button } from '@src/components/ui/button';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { FileAttachmentPicker, useFileStateAttach } from '@src/components/conversation/FileAttachmentPicker';
import { AttachMenu, AssetRefChips } from '@src/components/conversation/AttachMenu';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@src/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { SendProgressNotice } from '@src/components/conversation/SendProgressNotice';
import { errorMessage } from '@src/lib/error-message';
import { Check, ChevronDown, Loader2, MessageSquarePlus, Pencil, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/**
 * A special destination in place of the participant picker -- e.g. "IT · <agent> deployments". The dialog is
 * otherwise the standard one; Create hands the draft to `send`, which answers the conversation it landed in.
 */
export interface ConversationDestination {
  /** The one participant chip, e.g. "IT · Game Builder deployments (5 machines)". */
  label: string;
  /** A muted note beside it, e.g. "1 is IT Disabled". */
  note?: string | null;
  /** The title to offer instead of the participant-derived one. */
  title: string;
  /** The Create button's text. */
  sendLabel?: string;
  send: (draft: { title: string; text: string; files: File[] }) => Promise<string | null>;
}

interface NewConversationDialogProps {
  open: boolean;
  onClose: () => void;
  destination?: ConversationDestination | null;
}

export function NewConversationDialog({ open, onClose, destination = null }: NewConversationDialogProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const ctx = useDataContext();
  const { projects = [] } = useProjects();
  const { cloudUser, localUser } = useAuth();
  const { send, busy: sending, error: sendError, resetDraft } = useSendToConversation();
  const [destBusy, setDestBusy] = useState(false);
  const [destError, setDestError] = useState<string | null>(null);
  const busy = sending || destBusy;
  const error = destination ? destError : sendError;

  const [projectId, setProjectId] = useState<string>('');
  const [projectOpen, setProjectOpen] = useState(false);
  const selectedProject = projects.find((p) => p.id === projectId);
  const [participants, setParticipants] = useState<ConversationParticipant[]>([]);
  const [initialMessage, setInitialMessage] = useState('');
  const [title, setTitle] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const { addFiles, handlePaste } = useFileStateAttach(setFiles, { enabled: !busy, setText: setInitialMessage });
  const [assetRefs, setAssetRefs] = useState<AssetDescriptor[]>([]);
  // A one-shot prompt the receiver approves and runs once on their machine (null = none attached).
  const [callPrompt, setCallPrompt] = useState<string | null>(null);
  const [senderName, setSenderName] = useState('');
  const [editingName, setEditingName] = useState(false);

  // Reset the draft ONLY on the closed→open transition. Depending on the
  // ``projects`` array here wiped the form mid-typing: every project-row
  // update (the auto-indexer bumps it repeatedly on a fresh instance) yields a
  // new array identity, re-ran the reset, and dropped the participant the
  // user had just added — so Create stayed disabled with nothing to show why.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setParticipants([]);
      setInitialMessage('');
      setTitle('');
      setFiles([]);
      setAssetRefs([]);
      setCallPrompt(null);
      setEditingName(false);
      setDestError(null);
      setProjectId(ctx.project?.id ?? projects[0]?.id ?? '');
      resetDraft();
    }
    wasOpenRef.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- transition-gated; see above
  }, [open]);

  // The default project can arrive after the dialog opened; adopt it once,
  // without touching anything the user typed.
  useEffect(() => {
    if (!open || projectId) return;
    const fallback = ctx.project?.id ?? projects[0]?.id ?? '';
    if (fallback) setProjectId(fallback);
  }, [open, projectId, ctx.project?.id, projects]);

  useEffect(() => {
    const name = cloudUser?.name || cloudUser?.email || localUser?.name || '';
    if (name) setSenderName(name);
  }, [cloudUser?.email, cloudUser?.name, localUser?.name]);

  const isRemote = hasRemoteParticipant(participants);
  const projectName = projects.find((p) => p.id === projectId)?.displayName ?? null;
  const participantTitle = useAutoTitle(open, participants, projectName);
  const autofillTitle = destination?.title ?? participantTitle;

  const canCreate = destination
    ? !busy && initialMessage.trim().length > 0
    : !busy && (isRemote || !!projectId) && participants.length > 0;

  const handleCreate = async () => {
    if (!canCreate) return;
    const effectiveTitle = title.trim() || autofillTitle;
    if (destination) {
      setDestBusy(true);
      setDestError(null);
      try {
        const conversationId = await destination.send({ title: effectiveTitle, text: initialMessage.trim(), files });
        if (conversationId) {
          navigation.openDockOnThisPage(DockPointer.forConversation(conversationId));
          onClose();
        }
      } catch (e) {
        setDestError(errorMessage(e, t`Could not send.`));
      } finally {
        setDestBusy(false);
      }
      return;
    }
    const target: SendTarget = {
      kind: 'new',
      params: {
        project_id: projectId || null,
        members: participants,
        title: effectiveTitle,
      },
    };
    const payload: ConversationSendPayload = {
      text: initialMessage.trim(),
      files: files.length > 0 ? files : undefined,
      assetReferences: assetRefs.length > 0 ? assetRefs.map((a) => a.typeid) : undefined,
      callPrompt: callPrompt?.trim() || undefined,
    };
    const conversationId = await send(target, payload);
    if (conversationId) {
      navigation.openDockOnThisPage(DockPointer.forConversation(conversationId));
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md" data-testid="new-conversation-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquarePlus className="h-5 w-5 text-primary" />
            <Trans>New conversation</Trans>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 text-sm">
          {isRemote && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-medium">
                <Trans>From:</Trans>
              </span>
              {editingName ? (
                <input
                  className="border-b border-input bg-transparent text-xs text-foreground focus:outline-none"
                  value={senderName}
                  onChange={(e) => setSenderName(e.target.value)}
                  onBlur={() => {
                    setEditingName(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') {
                      setSenderName(cloudUser?.name || cloudUser?.email || localUser?.name || '');
                      setEditingName(false);
                    }
                  }}
                  autoFocus
                />
              ) : (
                <>
                  <span>{senderName || '...'}</span>
                  <button
                    type="button"
                    onClick={() => setEditingName(true)}
                    className="text-muted-foreground/50 transition-colors hover:text-muted-foreground"
                    title={t`Edit sender name`}
                    disabled={busy}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </>
              )}
            </div>
          )}

          {/* Title — pre-filled from participants + date. Click to select and
              replace. After any keystroke the autofill is suppressed until the
              dialog reopens. */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              <Trans>Title</Trans>
            </label>
            <AutofillInput
              autofill={autofillTitle}
              value={title}
              onChange={setTitle}
              data-testid="conversation-title-input"
            />
          </div>

          {/* Project — required for project-local conversations, optional for
              cross-user bundle conversations (stamped on the local Conversation
              and shipped as remote_project_id for the receiver's mapping). */}
          {!destination && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                {isRemote ? <Trans>Project (optional)</Trans> : <Trans>Project</Trans>}
              </label>
              <Popover open={projectOpen} onOpenChange={setProjectOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={projectOpen}
                    className="justify-between font-normal"
                    data-testid="new-conversation-project"
                  >
                    <span className={cn('truncate', !selectedProject && 'text-muted-foreground')}>
                      {selectedProject?.displayName ?? (isRemote ? t`No project` : t`Select a project`)}
                    </span>
                    <ChevronDown className="h-4 w-4 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command>
                    <CommandInput placeholder={t`Search projects…`} />
                    <CommandList>
                      <CommandEmpty>
                        <Trans>No projects found.</Trans>
                      </CommandEmpty>
                      {projects.map((p) => (
                        <CommandItem
                          key={p.id}
                          value={`${p.displayName} ${p.id}`}
                          onSelect={() => {
                            setProjectId(p.id ?? '');
                            setProjectOpen(false);
                          }}
                          className="cursor-pointer"
                        >
                          <span className="truncate">{p.displayName}</span>
                          <Check className={cn('ms-auto h-4 w-4', p.id === projectId ? 'opacity-100' : 'opacity-0')} />
                        </CommandItem>
                      ))}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
          )}

          {/* Participants */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              <Trans>Participants</Trans>
            </label>
            {destination ? (
              <div
                className="flex flex-wrap items-center gap-1 rounded-md border border-input px-2 py-1.5"
                data-testid="participant-input"
              >
                <span
                  className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] leading-4 text-foreground"
                  data-testid="conversation-destination"
                >
                  {destination.label}
                </span>
                {destination.note && <span className="text-xs text-muted-foreground">{destination.note}</span>}
              </div>
            ) : (
              <ContactPicker
                value={participants}
                onChange={setParticipants}
                excludeUserId={cloudUser?.id ?? ctx.user?.id}
                enabled={open}
                includeTeams
                testId="participant-input"
              />
            )}
          </div>

          {/* Initial message — required: a conversation always starts with one. */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              <Trans>Initial message</Trans>
            </label>
            <textarea
              className="min-h-[80px] rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={initialMessage}
              onChange={(e) => setInitialMessage(e.target.value)}
              onPaste={handlePaste}
              placeholder={isRemote ? t`Say hi…` : t`Type your first message…`}
              data-testid="initial-message-input"
            />
          </div>

          {/* Attachments — dropzone for file drag/drop + small menu for File/Asset. A message body only
              the desktop packs, so the hub page offers none. */}
          {(!isHubOnly() || destination) && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                  <Trans>Attachments</Trans>
                </label>
                {!destination && (
                  <AttachMenu
                    assetRefs={assetRefs}
                    onAssetRefsChange={setAssetRefs}
                    onFilesPicked={addFiles}
                    disabled={busy}
                    hideAssetList
                    // A prompt runs on another participant's machine — only a remote conversation has one.
                    onPromptPicked={isRemote && callPrompt === null ? () => setCallPrompt('') : undefined}
                  />
                )}
              </div>
              {/* Asset chips render below the label row, not inside it: inside a
                flex row the chip list sizes to its content (min-width:auto),
                so a long asset label pushes the row past the dialog edge
                instead of truncating. */}
              <AssetRefChips assetRefs={assetRefs} onChange={setAssetRefs} disabled={busy} />
              {callPrompt !== null && !destination && (
                <div className="relative" data-testid="new-conversation-prompt">
                  <textarea
                    autoFocus
                    className="min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 pe-8 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={callPrompt}
                    onChange={(e) => setCallPrompt(e.target.value)}
                    disabled={busy}
                    placeholder={t`Prompt — they approve it, it runs once on their machine…`}
                    data-testid="new-conversation-prompt-input"
                  />
                  <button
                    type="button"
                    className="absolute end-2 top-2 text-muted-foreground hover:text-foreground"
                    onClick={() => setCallPrompt(null)}
                    disabled={busy}
                    title={t`Remove prompt`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              <FileAttachmentPicker files={files} onChange={setFiles} disabled={busy} />
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex items-center gap-2 pt-2">
          <SendProgressNotice busy={busy} hasAttachments={files.length > 0 || assetRefs.length > 0} />
          <div className="ms-auto flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              onClick={() => void handleCreate()}
              disabled={!canCreate}
              className="gap-1.5"
              data-testid="new-conversation-submit"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {busy ? (destination ? t`Sending…` : t`Creating…`) : (destination?.sendLabel ?? t`Create`)}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
