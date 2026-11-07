import { useLingui } from '@lingui/react/macro';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@src/lib/utils';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { ITEM_ROLES, type ItemRole } from './role';
import { ITEM_STATES, type ItemState, type StateTone } from './item-state';

/** One thing the person can do from the card. `allowed === false` → not drawn. */
export interface ItemAction {
  key: string;
  label: ReactNode;
  onSelect: () => void;
  allowed?: boolean;
  primary?: boolean;
}

/**
 * How ONE item reads, on every card and every item header, hub and desktop alike. Each kind fills
 * this value; it never draws its own card.
 */
export interface ItemCardValue {
  title: ReactNode;
  /** A quieter suffix after the title ("on e2b"). */
  sub?: ReactNode;
  icon?: LucideIcon;
  state?: ItemState;
  role?: ItemRole;
  /** One line saying what is wrong, shown above the description. */
  warning?: ReactNode;
  description?: ReactNode;
  chips?: ReactNode[];
  /** When it last changed, and the word for it ("Updated", "Started", "Opened"). */
  at?: { date: string | Date | null | undefined; verb?: 'updated' | 'started' | 'opened' };
  actions?: ItemAction[];
  /** Kind-specific footer content that is not a plain action (an agent's deployment badges, an issue's fix). */
  footer?: ReactNode;
}

const TONE: Record<StateTone, string> = {
  success: 'bg-emerald-500/15 text-emerald-500',
  warning: 'bg-amber-500/15 text-amber-500',
  danger: 'bg-red-500/15 text-red-500',
  info: 'bg-sky-500/15 text-sky-400',
  muted: 'bg-muted text-muted-foreground',
};

const ROLE_TONE: Record<ItemRole, string> = {
  owner: 'border-primary/40 text-primary',
  admin: 'border-sky-500/40 text-sky-400',
  reader: 'border-border text-muted-foreground',
};

export function StatePill({ state }: { state: ItemState }) {
  const { i18n } = useLingui();
  const s = ITEM_STATES[state];
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', TONE[s.tone])}
      data-testid="item-state"
      data-state={state}
    >
      <span aria-hidden>●</span>
      {i18n._(s.label)}
    </span>
  );
}

export function RoleChip({ role }: { role: ItemRole | undefined }) {
  const { i18n } = useLingui();
  if (!role) return null;
  return (
    <span
      className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] leading-4', ROLE_TONE[role])}
      data-testid="item-role"
      data-role={role}
    >
      {i18n._(ITEM_ROLES[role])}
    </span>
  );
}

export function ItemChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] leading-4 text-muted-foreground">
      {children}
    </span>
  );
}

export function useItemTime(at: ItemCardValue['at']): string | null {
  const { t } = useLingui();
  const ago = formatTimeAgo(at?.date ?? null);
  if (!ago) return null;
  if (at?.verb === 'started') return t`Started ${ago}`;
  if (at?.verb === 'opened') return t`Opened ${ago}`;
  return t`Updated ${ago}`;
}

const visibleActions = (actions: ItemAction[] | undefined) => (actions ?? []).filter((a) => a.allowed !== false);

/** The item's actions the person may run — the same buttons on its card (`sm`) and its page header (`md`). */
export function ItemActions({ actions, size, testIdPrefix }: { actions?: ItemAction[]; size: 'sm' | 'md'; testIdPrefix: string }) {
  return (
    <>
      {visibleActions(actions).map((a) => (
        <button
          key={a.key}
          type="button"
          onClick={a.onSelect}
          className={cn(
            size === 'sm' ? 'rounded-md border px-2 py-0.5 text-xs hover:text-foreground' : 'rounded-md px-3 py-1.5 text-sm',
            size === 'sm'
              ? a.primary
                ? 'border-primary/50 text-primary'
                : 'border-border text-muted-foreground'
              : a.primary
                ? 'bg-primary text-primary-foreground'
                : 'border border-border text-foreground',
          )}
          data-testid={`${testIdPrefix}-${a.key}`}
        >
          {a.label}
        </button>
      ))}
    </>
  );
}

export const hasActions = (actions: ItemAction[] | undefined) => visibleActions(actions).length > 0;

export function ItemCard({ card, onOpen }: { card: ItemCardValue; onOpen: () => void }) {
  const time = useItemTime(card.at);
  const Icon = card.icon;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="flex cursor-pointer flex-col gap-2 rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="hub-items-card"
    >
      <div className="flex w-full items-center gap-2">
        {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {card.title}
          {card.sub && <span className="font-normal text-muted-foreground"> {card.sub}</span>}
        </span>
        {card.state && <StatePill state={card.state} />}
      </div>
      {card.role && (
        <div className="flex flex-wrap items-center gap-1.5">
          <RoleChip role={card.role} />
        </div>
      )}
      {card.warning && <p className="text-xs text-amber-500">⚠ {card.warning}</p>}
      {card.description && <p className="line-clamp-2 text-sm text-muted-foreground">{card.description}</p>}
      {!!card.chips?.length && (
        <div className="flex flex-wrap gap-1">
          {card.chips.map((c, i) => (
            <ItemChip key={i}>{c}</ItemChip>
          ))}
        </div>
      )}
      {(time || hasActions(card.actions) || card.footer) && (
        // Controls stop their own click so the card does not open underneath them.
        <div
          className="mt-auto flex items-center gap-2 border-t border-border pt-2 text-xs text-muted-foreground"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <span className="flex-1" data-testid="item-time">
            {time}
          </span>
          {card.footer}
          <ItemActions actions={card.actions} size="sm" testIdPrefix="item-action" />
        </div>
      )}
    </div>
  );
}
