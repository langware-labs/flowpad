import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { APIEntity, TypeId } from '@sdk';
import type { WikiLink } from '@sdk/types/wiki';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import { cn } from '@src/lib/utils';
import { RefreshCw } from 'lucide-react';

interface BacklinksTabProps {
  /** Serialized TypeId of the entity whose backlinks we display ("type-id"). */
  target: string | null;
}

export function BacklinksTab({ target }: BacklinksTabProps) {
  const { t } = useLingui();
  const typeId = useMemo(() => {
    if (!target) return null;
    try {
      return new TypeId(target);
    } catch {
      return null;
    }
  }, [target]);

  const { data: entity } = useEntity<APIEntity<APIEntity<unknown>>>(typeId);
  const [links, setLinks] = useState<WikiLink[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!entity) {
      setLinks(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const fetched = await entity.getBacklinks();
      setLinks(fetched);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLinks([]);
    } finally {
      setLoading(false);
    }
  }, [entity]);

  useEffect(() => {
    let cancelled = false;
    if (!entity) {
      setLinks(null);
      return;
    }
    setLoading(true);
    entity
      .getBacklinks()
      .then((fetched) => {
        if (!cancelled) {
          setLinks(fetched);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLinks([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entity]);

  if (!target) {
    return (
      <Empty data-testid="md-backlinks-panel">
        <Trans>No source for backlinks (this doc has no entity).</Trans>
      </Empty>
    );
  }
  if (loading && links === null) {
    return (
      <Empty data-testid="md-backlinks-panel">
        <RefreshCw className="mr-1 inline h-3 w-3 animate-spin" />
        <Trans>Loading backlinks…</Trans>
      </Empty>
    );
  }
  if (error) {
    return (
      <Empty data-testid="md-backlinks-panel">
        <Trans>Failed to load backlinks: {error}</Trans>
      </Empty>
    );
  }
  if (!links || links.length === 0) {
    return <Empty data-testid="md-backlinks-panel"><Trans>No backlinks yet.</Trans></Empty>;
  }

  return (
    <div
      className="flex h-full flex-col gap-1 overflow-y-auto p-2 text-[11px]"
      data-testid="md-backlinks-panel"
    >
      <div className="flex items-center justify-between px-1 pb-1 text-[10px] uppercase text-muted-foreground">
        <span>{links.length} backlink{links.length === 1 ? '' : 's'}</span>
        <button
          onClick={() => void refresh()}
          className="rounded px-1 hover:bg-muted"
          title={t`Refresh`}
          data-testid="md-backlinks-refresh"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </button>
      </div>
      {links.map((link) => (
        <div
          key={link.id ?? `${link.src_type}:${link.src_id}:${link.line}`}
          className="rounded border border-border bg-card px-2 py-1.5"
          data-testid="md-backlinks-item"
        >
          <div className="flex items-center justify-between">
            <span className="truncate font-mono text-[10px] text-muted-foreground">
              {link.src_type}
            </span>
            <span className="text-[10px] text-muted-foreground"><Trans>line {link.line}</Trans></span>
          </div>
          <div className="truncate" title={link.src_id}>{link.src_id}</div>
          {link.raw && (
            <div className="truncate text-[10px] italic text-muted-foreground" title={link.raw}>
              [[{link.raw}]]
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Empty({
  children,
  ...rest
}: { children: React.ReactNode } & Record<string, unknown>) {
  return (
    <div
      className="flex h-full items-center justify-center p-4 text-center text-[11px] text-muted-foreground"
      {...rest}
    >
      {children}
    </div>
  );
}
