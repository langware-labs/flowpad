/**
 * SessionActionsMenu — the one menu of the session top bar. Every action on a
 * running AgenticProcess that is not Fork lives here, on every surface:
 * session info, transcript, assets, restart, and the nav-out actions
 * (terminal, worktree, export).
 *
 * Restart awareness is backend-driven: any worker-relevant change flips
 * `process.restart_required`, and the menu button glows so the signal is not
 * hidden inside the closed menu.
 */

import { AgenticProcess } from '@sdk';
import { isProcessRunning } from '@sdk/process/agentic-types.js';
import { AssetManagerButton } from '@src/components/asset-manager';
import { compactEntityActionClassName } from '@src/components/entity-actions/action-button-styles';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { PopoverAnchor } from '@src/components/ui/popover';
import { resolveProcessDisplayName } from '@src/components/terminal/process-display-name';
import {
  Boxes,
  Download,
  FolderGit2,
  GitMerge,
  Info,
  Loader2,
  Menu,
  RotateCcw,
  ScrollText,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { EntityShareDialog } from './EntityShareDialog';
import { SessionInfoPopover } from './SessionInfoPopover';
import { useCommitMerge, useOpenInWorktree } from './use-worktree-actions';

interface SessionActionsMenuProps {
  process: AgenticProcess;
  /** At least one real assistant turn happened (gates Open transcript). */
  hasTranscript: boolean;
  sessionStartTime?: string | null;
  lastMessageTime?: string | null;
  /** Embedded mode: no nav-out actions (terminal, worktree, export). */
  embedded?: boolean;
  /** Sends a prompt to the session (Commit & merge). */
  onInjectPrompt: (text: string) => void;
}

export function SessionActionsMenu({
  process,
  hasTranscript,
  sessionStartTime,
  lastMessageTime,
  embedded,
  onInjectPrompt,
}: SessionActionsMenuProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  // The session info card opens once the menu has finished closing — on the
  // menu's own close event — not from the item's select: opened while the menu
  // is still dismissing, the card reads that dismissal as an interaction
  // outside itself and closes at once.
  const openInfoAfterClose = useRef(false);
  // The asset board is a heavy host (subscriptions, dialogs): it mounts on its
  // first open and stays, rather than idling under every session's top bar.
  const [assets, setAssets] = useState<'unmounted' | 'open' | 'closed'>('unmounted');
  const [exportOpen, setExportOpen] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);

  const hasSession = !!process.session_id;
  const started = isProcessRunning(process.status);
  const workdir = process.workdir ?? '';
  const restartHint = process.restart_required && started ? t`Restart required — config changed since start` : null;
  const commitMerge = useCommitMerge(process, onInjectPrompt);
  const worktree = useOpenInWorktree(process, { enabled: menuOpen && !embedded });

  const handleRestart = async () => {
    if (isRestarting) return;
    setIsRestarting(true);
    try {
      await process.restart();
    } finally {
      setIsRestarting(false);
    }
  };

  return (
    <>
      <SessionInfoPopover
        process={process}
        sessionStartTime={sessionStartTime}
        lastMessageTime={lastMessageTime}
        open={infoOpen}
        onOpenChange={setInfoOpen}
      >
        {/* Non-modal: its items open dialogs and the session info card. A modal
            menu locks `body` (pointer-events: none) while it is still closing,
            the dialog opening on top records that lock as the page's own, and
            restores it on close — leaving the whole app unclickable until a
            reload. */}
        <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
          {/* The session info card hangs from the menu button. */}
          <PopoverAnchor asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="process-toolbar-menu"
                data-restart-required={restartHint ? 'true' : 'false'}
                className={
                  restartHint
                    ? 'inline-flex h-7 w-7 animate-pulse items-center justify-center rounded bg-amber-500/20 text-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.55)] ring-2 ring-amber-500/60 transition-colors hover:bg-amber-500/30 dark:text-amber-400'
                    : compactEntityActionClassName
                }
                aria-label={t`Session actions`}
                title={restartHint ?? t`Session actions`}
              >
                <Menu className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
          </PopoverAnchor>
          <DropdownMenuContent
            align="end"
            className="w-64"
            onCloseAutoFocus={(e) => {
              if (!openInfoAfterClose.current) return;
              openInfoAfterClose.current = false;
              // Focus goes to the card, not back to the menu button.
              e.preventDefault();
              setInfoOpen(true);
            }}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              <Trans>Session</Trans>
            </DropdownMenuLabel>
            {hasSession && (
              <>
                <ActionItem
                  testId="session-action-info"
                  icon={Info}
                  label={t`Session info`}
                  onSelect={() => (openInfoAfterClose.current = true)}
                />
                <ActionItem
                  testId="session-action-transcript"
                  icon={ScrollText}
                  label={t`Open transcript`}
                  disabledReason={
                    hasTranscript
                      ? null
                      : !started
                        ? t`Session is not running`
                        : t`Send a message first — no transcript yet`
                  }
                  onSelect={() => {
                    // The vendor comes from the PROCESS, never a literal. Hardcoding
                    // 'claude' sent an opencode (or codex, or copilot) session to the
                    // claude lens category, which resolves a different transcript path.
                    navigation.openLens(process.transcriptLensCategory, 'transcript', process.session_id!);
                  }}
                />
              </>
            )}
            <ActionItem
              testId="session-action-assets"
              icon={Boxes}
              label={t`Manage assets`}
              onSelect={() => setAssets('open')}
            />
            <ActionItem
              testId="process-toolbar-restart"
              icon={RotateCcw}
              label={isRestarting ? t`Restarting…` : t`Restart session`}
              highlight={!!restartHint}
              hint={restartHint}
              disabledReason={isRestarting ? '' : !started ? t`Session is not running` : null}
              onSelect={() => void handleRestart()}
            />

            {!embedded && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  <Trans>Workspace</Trans>
                </DropdownMenuLabel>
                <ActionItem
                  testId="session-action-terminal"
                  icon={SquareTerminal}
                  label={t`Open terminal`}
                  hint={workdir || null}
                  onSelect={() => void navigation.openNewShell({ cwd: workdir || undefined })}
                />
                <ActionItem
                  testId="session-action-worktree"
                  icon={FolderGit2}
                  busy={worktree.loading}
                  label={t`Open in Worktree`}
                  hint={t`Open a new isolated git worktree session on a separate branch`}
                  disabledReason={
                    worktree.loading
                      ? ''
                      : worktree.hasCommit
                        ? null
                        : t`Requires a git repository with at least one commit`
                  }
                  onSelect={() => void worktree.open()}
                />
                {commitMerge.available && (
                  <ActionItem
                    testId="session-action-commit-merge"
                    icon={GitMerge}
                    busy={commitMerge.working}
                    label={commitMerge.working ? t`Working…` : t`Commit & Merge`}
                    hint={t`Commit all changes and merge back to the parent branch. Claude will exit the worktree when done.`}
                    disabledReason={commitMerge.working ? '' : null}
                    onSelect={commitMerge.run}
                  />
                )}
                {/* Share + Bookmark are NOT here: the top navigation bar carries
                    them for whatever it is addressing, this session included.
                    Export stays — the bar has no equivalent for it. */}
                <ActionItem
                  testId="entity-actions-export"
                  icon={Download}
                  label={t`Download bundle`}
                  onSelect={() => setExportOpen(true)}
                />
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SessionInfoPopover>

      {/* Reusable asset manager — same component the chat side panel uses,
          shown centered because it is opened from a menu item. */}
      {assets !== 'unmounted' && (
        <AssetManagerButton
          process={process}
          centered
          open={assets === 'open'}
          onOpenChange={(open) => setAssets(open ? 'open' : 'closed')}
        />
      )}

      {exportOpen && (
        <EntityShareDialog
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          typeId={process.typeId}
          defaultTitle={resolveProcessDisplayName(process)}
          allowCopyLink={false}
        />
      )}
    </>
  );
}

/**
 * One row: icon, label, and a muted second line — the reason it is disabled
 * when it is, otherwise an optional hint. A disabled row takes no pointer
 * events, so a tooltip could never explain it; the reason is printed instead.
 */
function ActionItem({
  icon: Icon,
  busy,
  label,
  hint,
  disabledReason,
  highlight,
  testId,
  onSelect,
}: {
  icon: LucideIcon;
  /** Show a spinner in place of the icon. */
  busy?: boolean;
  label: string;
  hint?: string | null;
  /** Non-null disables the row; a non-empty string is shown as why. */
  disabledReason?: string | null;
  highlight?: boolean;
  testId: string;
  onSelect: () => void;
}) {
  const disabled = disabledReason != null;
  const detail = disabled ? disabledReason : hint;
  return (
    <DropdownMenuItem
      data-testid={testId}
      disabled={disabled}
      onSelect={onSelect}
      className={`items-start gap-2 text-xs ${highlight ? 'text-amber-500 dark:text-amber-400' : ''}`}
    >
      {busy ? (
        <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
      ) : (
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      )}
      <span className="flex min-w-0 flex-col">
        <span className="font-medium">{label}</span>
        {detail && <span className="break-words text-[11px] text-muted-foreground">{detail}</span>}
      </span>
    </DropdownMenuItem>
  );
}
