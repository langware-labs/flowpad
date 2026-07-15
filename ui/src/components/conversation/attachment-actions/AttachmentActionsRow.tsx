import type { ReactNode } from 'react';
import type { AttachmentAction, AttachmentActionVariant } from './types';

/** Button styling per variant — lifted verbatim from the pre-registry
 *  PromptApprovalRow so the row is pixel-identical. */
const VARIANT_CLASS: Record<AttachmentActionVariant, string> = {
  primary:
    'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-emerald-500/60 bg-emerald-500/15 px-2.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/25 dark:text-emerald-300',
  view: 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-blue-400/40 bg-blue-500/10 px-2.5 text-xs font-medium text-blue-400 transition-colors hover:border-blue-400 hover:bg-blue-500/15 hover:text-blue-300',
  link: 'inline-flex h-7 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
  edit: 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/5 px-2.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-300',
};

interface AttachmentActionsRowProps {
  /** Bound, visible actions from `useAttachmentActions` — render order preserved. */
  actions: AttachmentAction[];
  /** Optional content renderer (e.g. <PromptAttachmentPreview/>) shown before the CTAs. */
  preview?: ReactNode;
}

/**
 * The generic attachment-actions row under a message bubble: one content
 * preview slot + one button per registry action. Replaces PromptApprovalRow —
 * prompt, spec, and any future attachment-action pair render through here.
 */
export function AttachmentActionsRow({ actions, preview }: AttachmentActionsRowProps) {
  if (actions.length === 0 && !preview) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[12px] text-muted-foreground">
      {preview}
      {actions.map((a) => {
        const Icon = a.icon;
        const iconCls = `h-3 w-3${a.pulse ? ' animate-pulse' : ''}`;
        // 'link' renders its icon trailing (matches the old Open Plan affordance).
        return (
          <button
            key={a.id}
            type="button"
            onClick={a.run}
            title={a.title}
            data-testid={a.testId}
            className={VARIANT_CLASS[a.variant]}
          >
            {a.variant !== 'link' && <Icon className={iconCls} />}
            {a.label}
            {a.variant === 'link' && <Icon className={iconCls} />}
          </button>
        );
      })}
    </div>
  );
}
