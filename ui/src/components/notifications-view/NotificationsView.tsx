/**
 * Email notification rules -- one view on the hub and the desktop (the desktop serves the hub page).
 * URL: `/dock/hub/notifications[/<rule key>]`. A key is the mute link's narrowest scope; the view
 * shows its hierarchy (broad -> narrow, one dot segment per level) with that key pre-selected.
 * Rules are the hub `notification_rule` entity, never per-machine preferences.
 */
import { notificationRulesService, type NotificationLevel, type NotificationRule } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@src/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@src/components/ui/radio-group';
import { Skeleton } from '@src/components/ui/skeleton';
import { Switch } from '@src/components/ui/switch';

const RULES_KEY = ['notification-rules'] as const;
const resolveKey = (ruleKey: string) => ['notification-rules', 'resolve', ruleKey] as const;

/** The list with ``rule`` in place of its row for ``key`` (or without it, when ``rule`` is null). */
function withRule(rules: NotificationRule[] | undefined, key: string, rule: NotificationRule | null) {
  const rest = (rules ?? []).filter((r) => r.rule_key !== key);
  return rule ? [...rest, rule] : rest;
}

/** The segment a level adds to its parent's key -- what the hierarchy shows on each row. */
export function segmentOf(levels: NotificationLevel[], index: number): string {
  const prev = index > 0 ? levels[index - 1].key : '';
  return prev ? levels[index].key.slice(prev.length + 1) : levels[index].key;
}

function MutePicker({ ruleKey }: { ruleKey: string }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const resolved = useQuery({
    queryKey: resolveKey(ruleKey),
    queryFn: () => notificationRulesService.resolve(ruleKey),
  });
  const levels = resolved.data?.ancestors ?? [];
  // The hub's hierarchy ends at the key itself, so the narrowest level is ``ruleKey``.
  const [picked, setPicked] = useState(ruleKey);
  const [muted, setMuted] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const run = async (key: string, mute: boolean) => {
    setFailed(false);
    try {
      const { rule } = await (mute ? notificationRulesService.mute(key) : notificationRulesService.unmute(key));
      setMuted(mute ? key : null);
      qc.setQueryData<NotificationRule[]>(RULES_KEY, (rules) => withRule(rules, key, rule));
      void qc.invalidateQueries({ queryKey: resolveKey(ruleKey), exact: true });
    } catch {
      setFailed(true);
    }
  };

  if (resolved.isLoading) return <Skeleton className="h-32 w-full" />;
  if (resolved.error) {
    return (
      <p className="text-sm text-destructive" data-testid="mute-picker-error">
        <Trans>This notification can't be found.</Trans>
      </p>
    );
  }
  return (
    <section className="mb-6 max-w-2xl rounded-lg border p-4" data-testid="mute-picker">
      <h2 className="mb-3 text-sm font-semibold">
        <Trans>Mute</Trans>
      </h2>
      <RadioGroup aria-label={t`Scope`} value={picked} onValueChange={setPicked} className="gap-1">
        {levels.map((level, i) => (
          <label
            key={level.key}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted"
            style={{ paddingInlineStart: `${0.5 + i * 1.25}rem` }}
            data-testid={`level-${i}`}
          >
            <RadioGroupItem value={level.key} />
            <code className="text-xs">{segmentOf(levels, i)}</code>
            <span className="text-muted-foreground">· {level.name}</span>
            {level.muted && (
              <span className="text-xs text-muted-foreground">
                <Trans>muted</Trans>
              </span>
            )}
          </label>
        ))}
      </RadioGroup>
      <div className="mt-3 flex items-center gap-3">
        {muted ? (
          <>
            <span className="text-sm" data-testid="muted-line">
              <Trans>Muted:</Trans> <code className="text-xs">{muted}</code>
            </span>
            <Button size="sm" variant="outline" data-testid="undo" onClick={() => void run(muted, false)}>
              <Trans>Undo</Trans>
            </Button>
          </>
        ) : (
          <Button size="sm" data-testid="mute" onClick={() => void run(picked, true)}>
            <Trans>Mute</Trans>
          </Button>
        )}
        {failed && (
          <span className="text-sm text-destructive" data-testid="mute-error">
            <Trans>Couldn't save. Try again.</Trans>
          </span>
        )}
      </div>
    </section>
  );
}

function RulesList({ rules }: { rules: NotificationRule[] }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (r: NotificationRule) =>
      r.muted ? notificationRulesService.unmute(r.rule_key) : notificationRulesService.mute(r.rule_key),
    onSuccess: ({ key, rule }) => qc.setQueryData<NotificationRule[]>(RULES_KEY, (all) => withRule(all, key, rule)),
  });
  if (!rules.length) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="rules-empty">
        <Trans>No email rules. Every notification email is on.</Trans>
      </p>
    );
  }
  return (
    <ul className="max-w-2xl divide-y rounded-lg border" data-testid="rules-list">
      {rules.map((r) => (
        <li key={r.rule_key} className="flex items-center justify-between gap-3 px-3 py-2">
          <code className="truncate text-xs" title={r.rule_key}>
            {r.rule_key}
          </code>
          <Switch
            checked={!r.muted}
            aria-label={r.rule_key}
            data-testid={`rule-${r.rule_key}`}
            onCheckedChange={() => toggle.mutate(r)}
          />
        </li>
      ))}
    </ul>
  );
}

export function NotificationsView({ pointer }: { pointer?: string }) {
  const rules = useQuery({ queryKey: RULES_KEY, queryFn: () => notificationRulesService.list() });
  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <header className="mb-4 flex items-center gap-2">
        <BellOff className="size-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">
          <Trans>Email notifications</Trans>
        </h1>
      </header>
      {pointer && <MutePicker key={pointer} ruleKey={pointer} />}
      <h2 className="mb-2 text-sm font-semibold">
        <Trans>Rules</Trans>
      </h2>
      {rules.isLoading && <Skeleton className="h-20 w-full max-w-2xl" />}
      {rules.error && (
        <p className="text-sm text-destructive" data-testid="rules-error">
          <Trans>Could not load your email rules.</Trans>
        </p>
      )}
      {rules.data && <RulesList rules={rules.data} />}
    </div>
  );
}
