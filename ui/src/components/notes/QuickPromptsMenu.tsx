import { useState } from 'react';
import type { Annotation } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { Briefcase, Plus, Trash2, User } from 'lucide-react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@src/components/ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useAuth } from '@src/hooks/useAuth';
import {
  addQuickPrompt,
  deleteNote,
  noteTitle,
  quickPromptTime,
  touchQuickPrompt,
  useQuickPrompts,
} from '@src/hooks/use-entity-notes';
import { formatTimeAgoShort } from '@src/utils/format-time-ago';
import { StickyNoteShape } from './StickyNoteShape';

/**
 * The terminal bar's quick prompts: saved notes (yours, and this project's) that one click types into
 * the session and submits. A Popover, not a tooltip — the inline box must survive the pointer leaving.
 */
export function QuickPromptsMenu({
  projectId,
  lastPromptText,
  isActive,
  onSend,
}: {
  projectId?: string | null;
  /** The session's last prompt — offered at the bottom to save as a quick prompt (never sent from there). */
  lastPromptText?: string | null;
  /** The worker's status, kept as a dot on the button (it replaced the status LED). */
  isActive: boolean;
  onSend: (text: string) => void;
}) {
  const { t } = useLingui();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const prompts = useQuickPrompts({ userId: user?.id, projectId }, open);
  const last = lastPromptText?.trim() ?? '';
  const offerLast = !!last && !!user?.id && !prompts.some((p) => (p.content ?? '').trim() === last);

  const run = (note: Annotation) => {
    onSend(note.content ?? '');
    setOpen(false);
    void touchQuickPrompt(note);
  };
  const saveMine = (text: string) => {
    if (user?.id) void addQuickPrompt(text, { type: 'user', id: user.id, name: user.name ?? '' });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t`Quick prompts`}
          aria-label={t`Quick prompts`}
          data-testid="quick-prompts-button"
          className="relative inline-flex h-6 w-6 items-center justify-center rounded hover:bg-muted"
        >
          <StickyNoteShape size={14} />
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ${isActive ? 'bg-emerald-500' : 'bg-red-500'}`}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-0" data-testid="quick-prompts-popover">
        <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            <Trans>Quick prompts</Trans>
          </p>
          <span className="text-[10px] text-muted-foreground">
            <Trans>Last used first · click to run</Trans>
          </span>
        </div>
        <div className="max-h-80 space-y-0.5 overflow-y-auto p-1.5">
          {prompts.length === 0 && (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">
              <Trans>No quick prompts yet. Type one below and press Enter.</Trans>
            </p>
          )}
          {prompts.map((p) => (
            <div
              key={p.id}
              data-testid="quick-prompt-row"
              className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 hover:bg-muted"
            >
              <ScopeIcon project={p.target_type === 'project'} />
              <button
                type="button"
                onClick={() => run(p)}
                data-testid="quick-prompt-run"
                className="flex min-w-0 flex-1 items-center gap-2 text-start"
              >
                <StickyNoteShape color={p.data?.color as string | undefined} size={18} />
                <span className="block min-w-0 flex-1 truncate text-xs text-foreground">{noteTitle(p)}</span>
              </button>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {formatTimeAgoShort(quickPromptTime(p))}
              </span>
              <button
                type="button"
                title={t`Delete`}
                aria-label={t`Delete`}
                onClick={() => void deleteNote(p)}
                data-testid="quick-prompt-delete"
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          <div className="mt-1 flex items-center gap-1.5 border-t border-border px-1.5 pt-2">
            <ScopeIcon project={false} />
            <input
              data-testid="quick-prompt-input"
              placeholder={t`Add new quick prompt…`}
              onKeyDown={(e) => {
                const text = e.currentTarget.value.trim();
                if (e.key !== 'Enter' || e.nativeEvent.isComposing || !text) return;
                e.preventDefault();
                saveMine(text);
                e.currentTarget.value = '';
              }}
              className="h-6 min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          {offerLast && (
            <HoverCard openDelay={300} closeDelay={0}>
              <HoverCardTrigger asChild>
                <button
                  type="button"
                  onClick={() => saveMine(last)}
                  data-testid="quick-prompt-last"
                  className="mt-1 flex w-full items-center gap-1.5 rounded px-1.5 py-1.5 text-start text-xs text-muted-foreground hover:bg-muted"
                >
                  <Plus className="h-3 w-3 shrink-0" />
                  <span className="shrink-0">
                    <Trans>Last in this session:</Trans>
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{last}</span>
                </button>
              </HoverCardTrigger>
              <HoverCardContent
                side="right"
                align="end"
                className="w-[28rem] max-w-[90vw] p-0"
                data-testid="quick-prompt-last-card"
              >
                <div className="border-b border-border px-3 py-2">
                  <p className="text-sm font-semibold text-foreground">
                    <Trans>Save as a quick prompt</Trans>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <Trans>Click to keep this session&apos;s last prompt. It is saved, not run.</Trans>
                  </p>
                </div>
                <p className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-sm leading-relaxed text-foreground">
                  {last}
                </p>
              </HoverCardContent>
            </HoverCard>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ScopeIcon({ project }: { project: boolean }) {
  const { t } = useLingui();
  const Icon = project ? Briefcase : User;
  return (
    <span className="shrink-0 text-muted-foreground" title={project ? t`This project` : t`Mine — every project`}>
      <Icon className="h-3 w-3" />
    </span>
  );
}
