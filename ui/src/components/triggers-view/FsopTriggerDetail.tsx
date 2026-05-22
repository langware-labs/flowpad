import { useEffect, useState } from 'react';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@src/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { ActionInfo, dataManager, Trigger as TriggerEntity, type ITrigger } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import Editor from '@monaco-editor/react';
import { ChevronRight, Copy } from 'lucide-react';
import { useTheme } from 'next-themes';
import { scopeColor } from './scope-colors';

declare const __API_URL__: string;

interface CallbackInfo {
  name: string;
  meaning: string | null;
  is_async: boolean;
}

interface Props {
  trigger: ITrigger;
}

/**
 * Read-only detail panel for FSOp triggers. Renders watch config, actions
 * with their registered callback meaning, and live stats (counter,
 * last_triggered, last_seen_* fingerprints).
 *
 * Default view is no-code: the registered callback's Python source is hidden
 * behind a collapsible. This is intentional — FSOp triggers are config, not
 * code, even though their behavior is implemented by a registered callback.
 *
 * For system triggers (the only kind today), the panel is read-only.
 * User-created FSOp triggers (future) will get an editable form here.
 */
export function FsopTriggerDetail({ trigger }: Props) {
  // Live entity subscription so counter/last_triggered/last_seen_* tick on WS updates.
  const { data: live } = useEntity<TriggerEntity>(trigger.id ? trigger.typeId : null);
  const t = live ?? trigger;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <Header trigger={t} />

      <div className="flex-1 space-y-4 p-4">
        <WatchSection trigger={t} />
        <ActionsSection trigger={t} />
        <StatsSection trigger={t} />
      </div>
    </div>
  );
}

function Header({ trigger }: { trigger: ITrigger }) {
  return (
    <div className="flex items-center gap-2 border-b px-3 py-2">
      <span className={cn(
        'rounded px-1.5 py-0.5 text-[10px] font-medium',
        scopeColor(trigger.scope),
      )}>
        {trigger.scope || 'user'}
      </span>
      <span className="font-medium">{trigger.displayName}</span>
      {trigger.enabled === false && (
        <Badge variant="secondary" className="h-4 px-1 text-[9px]">disabled</Badge>
      )}
      <Badge variant="outline" className="h-4 px-1 text-[9px] font-mono">fsop</Badge>
      {trigger.description && (
        <span className="ml-2 truncate text-xs text-muted-foreground">{trigger.description}</span>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

function FieldRow({ label, value, mono = false, copyable = false }: {
  label: string; value: React.ReactNode; mono?: boolean; copyable?: boolean;
}) {
  const stringValue = typeof value === 'string' ? value : null;
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('flex-1 break-all', mono && 'font-mono')}>{value || '—'}</span>
      {copyable && stringValue && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={() => void navigator.clipboard.writeText(stringValue)}
            >
              <Copy className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function WatchSection({ trigger }: { trigger: ITrigger }) {
  return (
    <section className="space-y-1.5">
      <SectionLabel>Watch</SectionLabel>
      <FieldRow label="path" value={trigger.watch_path} mono copyable />
      <FieldRow label="recursive" value={String(trigger.recursive ?? false)} />
      <FieldRow label="glob" value={trigger.watch_glob || '—'} mono />
    </section>
  );
}

function ActionsSection({ trigger }: { trigger: ITrigger }) {
  // `trigger.action` is the legacy singular field; `trigger.actions` is the
  // plural list. The TS shape today exposes only `action` — fall back to
  // wrapping it as a 1-list. Future TS typing should mirror the Python
  // `actions: list[TriggerAction]`.
  const actions: Array<{ action_type?: string; callback_name?: string; script_path?: string; script_filename?: string }> =
    (trigger as ITrigger & { actions?: unknown[] }).actions
      ? ((trigger as ITrigger & { actions?: unknown[] }).actions as Array<{
          action_type?: string;
          callback_name?: string;
          script_path?: string;
          script_filename?: string;
        }>)
      : trigger.action
        ? [trigger.action as { action_type?: string; callback_name?: string; script_path?: string; script_filename?: string }]
        : [];

  return (
    <section className="space-y-2">
      <SectionLabel>Actions ({actions.length})</SectionLabel>
      {actions.length === 0 && (
        <div className="text-xs text-muted-foreground">No actions configured.</div>
      )}
      {actions.map((a, i) => (
        <ActionRow key={i} action={a} triggerId={trigger.id ?? null} />
      ))}
    </section>
  );
}

function ActionRow({ action, triggerId }: {
  action: { action_type?: string; callback_name?: string; script_path?: string; script_filename?: string };
  triggerId: string | null;
}) {
  const kind = action.action_type ?? 'nop';
  return (
    <div className="rounded border bg-muted/30 px-2 py-1.5">
      <div className="flex items-center gap-2 text-xs">
        <Badge variant="outline" className="h-4 px-1 text-[9px] font-mono">{kind}</Badge>
        {action.callback_name && (
          <span className="font-mono">{action.callback_name}</span>
        )}
        {action.script_path && (
          <span className="font-mono text-muted-foreground">{action.script_path}</span>
        )}
        {action.script_filename && (
          <span className="font-mono text-muted-foreground">{action.script_filename}</span>
        )}
      </div>
      {action.callback_name && (
        <CallbackMeaning name={action.callback_name} />
      )}
      {action.action_type === 'callback' && triggerId && (
        <CallbackSourceCollapsible triggerId={triggerId} />
      )}
    </div>
  );
}

function CallbackMeaning({ name }: { name: string }) {
  const [meaning, setMeaning] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch(`${__API_URL__}/api/v1/debug/trigger_callbacks`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { callbacks: CallbackInfo[] }) => {
        if (cancelled) return;
        const entry = data.callbacks?.find((c) => c.name === name);
        setMeaning(entry?.meaning ?? null);
      })
      .catch(() => { if (!cancelled) setMeaning(null); });
    return () => { cancelled = true; };
  }, [name]);

  if (meaning === undefined) return null;
  if (!meaning) return null;
  return (
    <div className="mt-1 text-[11px] text-muted-foreground">{meaning}</div>
  );
}

function CallbackSourceCollapsible({ triggerId }: { triggerId: string }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (!open || loaded) return;
    const action = new ActionInfo('trigger-content', 'trigger', triggerId, 'GET');
    dataManager.callAction<undefined, { content: string }>(action)
      .then((data) => {
        const c = (data as { content?: string } | null)?.content ?? '';
        setContent(c);
        setLoaded(true);
      })
      .catch((e: Error) => setError(e.message));
  }, [open, loaded, triggerId]);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-2">
      <CollapsibleTrigger className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        View callback source
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 h-64 overflow-hidden rounded border">
          {error ? (
            <div className="p-3 text-xs text-destructive">Could not load source: {error}</div>
          ) : !loaded ? (
            <div className="p-3 text-xs text-muted-foreground">Loading…</div>
          ) : (
            <Editor
              height="100%"
              language="python"
              value={content}
              theme={resolvedTheme === 'dark' ? 'vs-dark' : 'light'}
              options={{
                readOnly: true,
                fontSize: 12,
                lineHeight: 18,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                wordWrap: 'on',
                padding: { top: 8, bottom: 8 },
                lineNumbers: 'on',
                folding: true,
              }}
            />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function StatsSection({ trigger }: { trigger: ITrigger }) {
  return (
    <section className="space-y-1.5">
      <SectionLabel>Stats</SectionLabel>
      <FieldRow
        label="fires"
        value={<span className="font-mono">{trigger.counter ?? 0}</span>}
      />
      <FieldRow
        label="last triggered"
        value={trigger.last_triggered
          ? new Date(trigger.last_triggered).toLocaleString()
          : '—'}
      />
      <FieldRow
        label="last_seen_mtime"
        value={trigger.last_seen_mtime != null ? String(trigger.last_seen_mtime) : '—'}
        mono
      />
      <FieldRow
        label="last_seen_size"
        value={trigger.last_seen_size != null ? `${trigger.last_seen_size} bytes` : '—'}
        mono
      />
    </section>
  );
}
