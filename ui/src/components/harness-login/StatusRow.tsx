/**
 * ONE row, one line, for every thing that can pay for a call.
 *
 * FlowPad, the assistants, the key store and the hub endpoints are different underneath — a hub
 * login, a vendor device login, a stored secret, a budget — and they answer the SAME question:
 * what pays. So they get the same fixed-height line: mark · name + a small fact · ONE state pill
 * · the one button that acts on it. No second line, no sub-table: a row that needed more was
 * the old modal growing a detail view inside a list, and the detail now has a page of its own.
 *
 * The pill word is a wikitip: hover explains the state, click opens the page. The pill itself
 * is a `span[role=button]`, not a `<button>`, because `WikiLabel` renders one and nesting them
 * is invalid.
 */
import { i18n } from '@lingui/core';
import { useLingui } from '@lingui/react/macro';
import { Check, ChevronRight, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@src/components/ui/button';
import { useAssistantWikiSpace } from '@src/components/wiki-tip/assistant-wiki';
import { WikiLabel } from '@src/components/wiki-tip/WikiLabel';

import { PILL_TONE, type FundingPill, type PillKind } from './funding-pill';

/** The shipped wiki page every state word on this screen points into. */
export const FUNDING_WIKI_PAGE = 'Assistant funding states';

/** Heading slug on that page, per pill kind. */
const WIKI_FRAGMENT: Record<PillKind, string> = {
  plan: 'plan',
  api_key: 'api-key',
  hub: 'llm-endpoint',
  signed_out: 'signed-out',
  none: 'signed-out',
  not_installed: 'not-installed',
  not_checked: 'signed-out',
  signing_in: 'plan',
};

export function StatePill({
  pill,
  text,
  fragment,
  testId,
  onClick,
}: {
  pill: FundingPill;
  /** Overrides the pill's own word (the keys row says "1 of 3 set"). */
  text?: string;
  /** Overrides the wiki heading the word points at. */
  fragment?: string;
  testId: string;
  onClick?: () => void;
}) {
  const space = useAssistantWikiSpace();
  const word = text ?? i18n._(pill.short);
  const Icon = pill.kind === 'signing_in' ? Loader2 : pill.Icon;
  return (
    <span
      role={onClick ? 'button' : undefined}
      tabIndex={-1}
      onClick={onClick}
      data-testid={testId}
      data-state={pill.kind}
      title={pill.title ?? i18n._(pill.label)}
      className={`inline-flex h-7 w-[210px] shrink-0 items-center gap-1.5 overflow-hidden rounded-full border bg-muted/30 px-2.5 text-xs ${PILL_TONE[pill.kind]} ${
        onClick ? 'cursor-pointer' : ''
      }`}
    >
      <Icon className={`h-3.5 w-3.5 shrink-0 ${pill.kind === 'signing_in' ? 'animate-spin' : ''}`} />
      <span className="truncate" onClick={(e) => e.stopPropagation()}>
        <WikiLabel wikiword={FUNDING_WIKI_PAGE} fragment={fragment ?? WIKI_FRAGMENT[pill.kind]} label={word} space={space} />
      </span>
      {pill.amount && <span className="ml-auto shrink-0 pl-1 font-mono text-[10px] opacity-90">{pill.amount}</span>}
    </span>
  );
}

export function StatusRow({
  testId,
  mark,
  name,
  small,
  pill,
  pillText,
  pillFragment,
  action,
  actionBusy,
  onAction,
  emphasis,
  isDefault,
  onMakeDefault,
}: {
  testId: string;
  mark: ReactNode;
  name: ReactNode;
  /** The one small fact beside the name: identity and plan, a sign-out note, the providers. */
  small?: ReactNode;
  pill: FundingPill;
  pillText?: string;
  pillFragment?: string;
  /** The button's label — "Sign in", "Add key", or the default "Details ›". */
  action?: ReactNode;
  actionBusy?: boolean;
  onAction: () => void;
  emphasis?: boolean;
  /** Present only on rows that CAN be the default assistant. */
  isDefault?: boolean;
  onMakeDefault?: () => void;
}) {
  const { t } = useLingui();
  return (
    <div
      data-testid={testId}
      className={`flex h-12 w-full items-center gap-3 rounded-xl border px-3 ${
        emphasis ? 'border-primary/40 bg-primary/5' : 'border-border/70 bg-card/40'
      }`}
    >
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border/60 bg-background/70">
        {mark}
      </div>

      <div className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden whitespace-nowrap">
        {onMakeDefault && (
          <button
            type="button"
            onClick={onMakeDefault}
            title={isDefault ? t`This is your default assistant` : t`Make this the default assistant`}
            aria-pressed={isDefault}
            data-testid={`${testId}-default`}
            className={`shrink-0 self-center rounded-md p-0.5 transition-colors ${
              isDefault ? 'text-emerald-500' : 'text-muted-foreground/25 hover:text-muted-foreground'
            }`}
          >
            <Check className="h-3.5 w-3.5" />
          </button>
        )}
        <span className="shrink-0 text-[15px] font-medium">{name}</span>
        {small && <span className="min-w-0 truncate text-xs text-muted-foreground">{small}</span>}
      </div>

      <StatePill pill={pill} text={pillText} fragment={pillFragment} testId={`${testId}-status`} onClick={onAction} />

      <Button
        size="sm"
        variant={emphasis ? 'default' : 'ghost'}
        className="h-8 w-[92px] shrink-0 gap-0.5 px-2"
        disabled={actionBusy}
        onClick={onAction}
        data-testid={`${testId}-action`}
      >
        {actionBusy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          (action ?? (
            <>
              {t`Details`}
              <ChevronRight className="h-3.5 w-3.5" />
            </>
          ))
        )}
      </Button>
    </div>
  );
}
