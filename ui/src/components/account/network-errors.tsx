import apiClient from '@sdk/client';
import { Button } from '@src/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@src/components/ui/collapsible';
import { Trans } from '@lingui/react/macro';
import { ChevronDown, CloudOff } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';

const NETWORK_ERRORS = '/api/v1/network-errors';

/** One failed hub call, as the backend recorded it (`NetworkErrorEntry`). */
export interface NetworkErrorEntry {
  at: number; // seconds since the epoch
  method: string;
  path: string;
  status: number;
  message: string;
  rule: string;
  shown: boolean;
}

export interface NetworkErrorGroup {
  key: string;
  method: string;
  path: string;
  status: number;
  rule: string;
  /** Any of them raised the visible warning. */
  shown: boolean;
  /** When the latest of them failed, seconds since the epoch. */
  lastAt: number;
  entries: NetworkErrorEntry[];
}

/** The failures of one call (method + path + status) together, the latest failing call first. */
export function groupNetworkErrors(entries: NetworkErrorEntry[]): NetworkErrorGroup[] {
  const groups = new Map<string, NetworkErrorGroup>();
  for (const entry of entries) {
    const { method, path, status, rule } = entry;
    const key = `${method} ${path} ${status}`;
    const group = groups.get(key) ?? { key, method, path, status, rule, shown: false, lastAt: 0, entries: [] };
    group.entries.push(entry);
    group.shown ||= entry.shown;
    group.lastAt = entry.at;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.lastAt - a.lastAt);
}

const time = (at: number) => new Date(at * 1000).toLocaleString();

/** Every hub call that failed since the backend started — shown or silent — with a Clear. */
export function NetworkErrors() {
  const [isOpen, setIsOpen] = useState(false);
  const [entries, setEntries] = useState<NetworkErrorEntry[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  type Answer = { entries: NetworkErrorEntry[] };
  const refresh = useCallback(async () => {
    setEntries((await apiClient.get<Answer>(NETWORK_ERRORS))?.entries ?? []);
  }, []);
  const clear = async () => {
    await apiClient.delete<Answer>(NETWORK_ERRORS);
    setEntries([]);
  };

  useEffect(() => {
    if (isOpen) void refresh().catch(() => setEntries([]));
  }, [isOpen, refresh]);

  const groups = useMemo(() => groupNetworkErrors(entries), [entries]);

  return (
    <div className="mt-6" data-testid="network-errors">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <div className="flex cursor-pointer items-center justify-between border-b pb-3 text-sm font-medium text-muted-foreground hover:text-foreground">
            <div className="flex items-center gap-2">
              <CloudOff className="h-4 w-4" />
              <span>
                <Trans>Network errors</Trans>
              </span>
            </div>
            <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-4">
          <div className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {entries.length ? (
                  <Trans>{entries.length} failed cloud requests since Flowpad started</Trans>
                ) : (
                  <Trans>No failed cloud requests since Flowpad started</Trans>
                )}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => void refresh()}>
                  <Trans>Refresh</Trans>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!entries.length}
                  data-testid="network-errors-clear"
                  onClick={() => void clear()}
                >
                  <Trans>Clear</Trans>
                </Button>
              </div>
            </div>
            {groups.length > 0 && (
              <table className="w-full text-start text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    {[
                      <Trans key="request">Request</Trans>,
                      <Trans key="status">Status</Trans>,
                      <Trans key="times">Times</Trans>,
                      <Trans key="last">Last</Trans>,
                      <Trans key="warning">Warning</Trans>,
                    ].map((label) => (
                      <th key={label.key} className="py-1 pe-2 text-start font-medium">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <Fragment key={group.key}>
                      <tr
                        className="cursor-pointer border-t hover:bg-muted/50"
                        data-testid="network-error-row"
                        onClick={() => setExpanded(expanded === group.key ? null : group.key)}
                      >
                        <td className="break-all py-1 pe-2 font-mono">
                          {group.method} {group.path}
                        </td>
                        <td className="py-1 pe-2">{group.status === 0 ? <Trans>No response</Trans> : group.status}</td>
                        <td className="py-1 pe-2">{group.entries.length}</td>
                        <td className="whitespace-nowrap py-1 pe-2">{time(group.lastAt)}</td>
                        <td className="py-1">{group.shown ? <Trans>Shown</Trans> : <Trans>Silent</Trans>}</td>
                      </tr>
                      {expanded === group.key && (
                        <tr>
                          <td colSpan={5} className="bg-muted/30 p-2">
                            <div className="mb-1 text-muted-foreground">
                              <Trans>Rule: {group.rule}</Trans>
                            </div>
                            {group.entries.map((entry, i) => (
                              <div key={i} className="break-all font-mono">
                                {time(entry.at)} {entry.shown ? '!' : '·'} {entry.message}
                              </div>
                            ))}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
