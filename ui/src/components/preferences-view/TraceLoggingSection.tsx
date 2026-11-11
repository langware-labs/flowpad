import { Trans } from '@lingui/react/macro';
import apiClient from '@sdk/client';
import { toplog } from '@sdk';
import { SystemLog } from '@src/components/account/system-log';
import { SettingRow, SettingsCard } from '@src/components/settings/settings-card';
import { Badge } from '@src/components/ui/badge';
import { Switch } from '@src/components/ui/switch';
import { useEffect, useState, useSyncExternalStore } from 'react';

type CatalogTag = { tag: string; description: string; default_on: boolean };

const subscribe = (listener: () => void) => toplog.subscribe(listener);
const snapshot = () => toplog.state();
/** The catalog is a backend constant: fetched once per page, not on every visit to the tab. */
let catalogOnce: Promise<CatalogTag[]> | null = null;
const loadCatalog = () =>
  (catalogOnce ??= apiClient
    .get<CatalogTag[]>('/toplog/tags')
    .then((rows) => rows ?? [])
    .catch(() => {
      catalogOnce = null;
      return [];
    }));

/**
 * Preferences → Developer → Trace logging: the toplog switches. The state is the
 * toplog manager's mirror of the instance's `toplog.json`, so a CLI or agent toggle
 * shows here at once; the tag list is the backend catalog plus any tag that is on
 * without being catalogued.
 */
export function TraceLoggingSection() {
  const state = useSyncExternalStore(subscribe, snapshot);
  const [catalog, setCatalog] = useState<CatalogTag[]>([]);
  const [lastOn, setLastOn] = useState<string | null>(null);

  useEffect(() => {
    void loadCatalog().then(setCatalog);
  }, []);

  const known = new Set(catalog.map((c) => c.tag));
  const rows: CatalogTag[] = [
    ...catalog,
    ...Object.keys(state.filter)
      .filter((tag) => !known.has(tag))
      .map((tag) => ({ tag, description: '', default_on: false })),
  ];
  const onCount = rows.filter((r) => state.filter[r.tag]).length;

  const toggle = (tag: string, on: boolean) => {
    setLastOn(on ? tag : null);
    void (on ? toplog.on(tag) : toplog.off(tag));
  };

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard>
        <SettingRow
          htmlFor="toplog-master"
          label={<Trans>Trace logging</Trans>}
          description={
            <Trans>
              Writes debug lines for the tags turned on below into this instance's log. Off: nothing is written,
              whatever the tags say.
            </Trans>
          }
          control={
            <Switch
              id="toplog-master"
              data-testid="toplog-master"
              checked={state.enabled}
              onCheckedChange={(on) => void (on ? toplog.enable() : toplog.disable())}
            />
          }
        />
        <SettingRow
          htmlFor="toplog-persist"
          label={<Trans>Keep after restart</Trans>}
          description={
            <Trans>
              A restart turns every tag off except the ones on by default. Turn this on to keep your set while chasing
              a restart bug.
            </Trans>
          }
          control={
            <Switch
              id="toplog-persist"
              data-testid="toplog-persist"
              checked={state.persist}
              onCheckedChange={(on) => void toplog.persist(on === true)}
            />
          }
        />
      </SettingsCard>

      {lastOn && state.filter[lastOn] && (
        <div className="rounded-lg border border-primary/40 bg-primary/10 px-4 py-3 text-xs text-foreground">
          <Trans>
            Logging <span className="font-mono">{lastOn}</span> now. It stays on until you turn it off or Flowpad
            restarts.
          </Trans>
        </div>
      )}

      <div className="px-1">
        <h3 className="text-sm font-semibold text-foreground">
          <Trans>Tags</Trans>
        </h3>
        <p className="mt-1 text-xs text-muted-foreground" data-testid="toplog-count">
          <Trans>
            {onCount} of {rows.length} on
          </Trans>
        </p>
      </div>
      <SettingsCard>
        {rows.map((row) => (
          <SettingRow
            key={row.tag}
            htmlFor={`toplog-tag-${row.tag}`}
            label={
              <span className="font-mono">
                {row.tag}
                {row.default_on && (
                  <Badge variant="muted" className="ms-2 font-sans font-normal">
                    <Trans>on by default</Trans>
                  </Badge>
                )}
              </span>
            }
            description={row.description || undefined}
            control={
              <Switch
                id={`toplog-tag-${row.tag}`}
                data-testid={`toplog-tag-${row.tag}`}
                checked={!!state.filter[row.tag]}
                onCheckedChange={(on) => toggle(row.tag, on === true)}
              />
            }
          />
        ))}
      </SettingsCard>

      <SystemLog />
    </div>
  );
}
