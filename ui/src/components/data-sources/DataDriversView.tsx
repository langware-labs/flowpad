/**
 * The installed drivers — the templates a data source is an instance of — and one
 * driver's page. Both render inside the Data sources view, addressed by its
 * pointer (`drivers`, `drivers/<name>`; see data-sources-pointer.ts), so the
 * address bar reads `Data sources › Drivers › <driver>` and every level reloads.
 *
 * URL-first: a row click only navigates. What is shown is derived from the
 * pointer, never from a selection held here. The sources come from the parent
 * view, which already holds the one live query for them.
 */
import { useMemo } from 'react';
import { DataDriver, DataSource } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { openCredentials } from '@src/components/credentials-view/credentials-pointer';
import { WikiButton } from '@src/components/wiki-tip';
import { SimpleDirTree } from '@src/components/terminal/interactive-terminal/side-windows/SimpleDirTree';
import { cn } from '@src/lib/utils';
import { OpenFolderButton } from './OpenFolderButton';
import { HEADER_ROW } from './DataSourceRow';
import { openDriver, openSourceFile } from './data-sources-pointer';
import { sourceIcon } from './source-icon';
import { useSourceSpecs } from './use-source-specs';

const driverTitle = (driver: DataDriver) => driver.title || driver.name;

const DRIVER_GRID = 'grid grid-cols-[minmax(0,1fr)_minmax(0,16rem)_5rem_auto] items-center gap-3 px-4 py-2';

export function DataDriversList({ sources }: { sources: DataSource[] }) {
  const { navigation } = useDockNavigation();
  const { specs } = useSourceSpecs();
  const inUse = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sources) counts.set(s.provider, (counts.get(s.provider) ?? 0) + 1);
    return counts;
  }, [sources]);
  const sorted = useMemo(() => [...specs].sort((a, b) => driverTitle(a).localeCompare(driverTitle(b))), [specs]);

  return (
    <div data-testid="data-drivers-list" className="overflow-hidden rounded-lg border border-border">
      <div className={cn(DRIVER_GRID, HEADER_ROW)}>
        <span>
          <Trans>Driver</Trans>
        </span>
        <span>
          <Trans>Kind</Trans>
        </span>
        <span>
          <Trans>Sources</Trans>
        </span>
        <span className="text-end">
          <Trans>Folder</Trans>
        </span>
      </div>
      {sorted.map((driver) => {
        const Icon = sourceIcon(driver, null);
        return (
          <div
            key={driver.name}
            className={cn(DRIVER_GRID, 'border-b border-border last:border-b-0 hover:bg-accent/50')}
          >
            <button
              type="button"
              data-testid={`data-driver-row-${driver.name}`}
              className="flex min-w-0 items-center gap-2 text-start"
              onClick={() => openDriver(navigation, driver.name)}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm font-medium">{driverTitle(driver)}</span>
              {driver.title && driver.title !== driver.name && (
                <span className="truncate font-mono text-xs text-muted-foreground">{driver.name}</span>
              )}
              {driver.load_error && (
                <span className="rounded bg-red-500/10 px-1.5 text-[10px] text-red-600 dark:text-red-400">
                  <Trans>load error</Trans>
                </span>
              )}
            </button>
            <span className="truncate font-mono text-xs text-muted-foreground" title={driver.kind}>
              {driver.kind || '—'}
            </span>
            <span className="text-xs text-muted-foreground">{inUse.get(driver.name) ?? 0}</span>
            <span className="flex justify-end">
              <OpenFolderButton path={driver.asset_ref} testId={`data-driver-folder-${driver.name}`} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function DataDriverPage({ name, sources }: { name: string; sources: DataSource[] }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { specFor } = useSourceSpecs();
  const driver = specFor(name);
  const instances = useMemo(() => sources.filter((s) => s.provider === name), [sources, name]);
  const SourceTypeIcon = iconForType(DataSource.type);

  if (!driver) {
    return (
      <p data-testid="data-driver-missing" className="text-sm text-muted-foreground">
        <Trans>No driver named {name} is installed.</Trans>
      </p>
    );
  }

  const Icon = sourceIcon(driver, null);
  const { credential, connector } = (driver.auth ?? {}) as { credential?: string; connector?: string };
  const fields = Object.entries(driver.config ?? {});
  const folder = driver.asset_ref ?? null;
  // A file of this driver's folder, in the editor. Every property below that lives in a file links to it.
  const openFile = (file: string) => folder && navigation.openMachinePath(`${folder}/${file}`, LOCAL_COMPUTE_NODE);
  const manifest = () => openFile('data_driver.json');
  const code = () => openFile('source.py');
  const facts: { label: string; value: string; onClick?: () => void }[] = [
    { label: t`Name`, value: driver.name, onClick: manifest },
    { label: t`Kind`, value: driver.kind || '—', onClick: manifest },
    { label: t`Runtime`, value: driver.runtime || '—', onClick: manifest },
    { label: t`Code`, value: 'source.py', onClick: code },
    { label: t`Sends replies`, value: driver.sends ? t`yes` : t`no`, onClick: code },
    // The credential is a connection: its values are set on the Connections screen.
    {
      label: t`Credential`,
      value: credential || connector || t`none`,
      onClick: credential || connector ? () => openCredentials(navigation) : undefined,
    },
    { label: t`Folder`, value: folder || '—', onClick: folder ? () => navigation.openFolder(folder) : undefined },
  ];

  return (
    <div data-testid={`data-driver-page-${driver.name}`} className="flex max-w-4xl flex-col gap-5">
      <header className="flex items-center gap-2">
        <Icon className="size-5 text-muted-foreground" />
        <h2 className="text-base font-semibold">{driverTitle(driver)}</h2>
        <OpenFolderButton path={folder} testId="data-driver-page-folder" />
      </header>
      {driver.description && <p className="text-sm text-muted-foreground">{driver.description}</p>}
      {driver.load_error && (
        <p className="rounded bg-red-500/10 px-2 py-1.5 text-xs text-red-700 dark:text-red-300">{driver.load_error}</p>
      )}

      <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {facts.map(({ label, value, onClick }) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-all font-mono text-xs leading-5">
              {onClick ? (
                <button
                  type="button"
                  className="text-start text-primary hover:underline"
                  data-testid={`data-driver-fact-${label}`}
                  onClick={onClick}
                >
                  {value}
                </button>
              ) : (
                value
              )}
            </dd>
          </div>
        ))}
        {driver.setup_wiki && (
          <div className="contents">
            <dt className="text-muted-foreground">
              <Trans>Setup guide</Trans>
            </dt>
            <dd>
              <WikiButton wikiword={driver.setup_wiki} linkText={driver.setup_wiki} />
            </dd>
          </div>
        )}
      </dl>

      {folder && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">
            <Trans>Files</Trans>
          </h3>
          {/* The editor's own file tree, rooted at the folder: a file opens in the editor. */}
          <div data-testid="data-driver-files" className="h-96 overflow-hidden rounded-lg border border-border">
            <SimpleDirTree
              key={folder}
              computeNodeTypeId={LOCAL_COMPUTE_NODE}
              locatorTypeId={LOCAL_COMPUTE_NODE}
              topLevel={folder}
            />
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">
          <Trans>Config fields</Trans>
        </h3>
        {fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>This driver takes no config.</Trans>
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border text-sm">
            {fields.map(([key, field]) => (
              <button
                key={key}
                type="button"
                title={t`Open data_driver.json`}
                onClick={manifest}
                className="grid w-full grid-cols-[10rem_5rem_minmax(0,1fr)] gap-3 border-b border-border px-3 py-1.5 text-start last:border-b-0 hover:bg-accent/50"
              >
                <span className="truncate font-medium" title={key}>
                  {field.label || key}
                </span>
                <span className="font-mono text-xs text-muted-foreground">{field.type || 'text'}</span>
                <span className="text-xs text-muted-foreground">{field.hint || ''}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">
          <Trans>Sources using this driver</Trans>
        </h3>
        {instances.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>None yet.</Trans>
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            {instances.map((source) => (
              <div
                key={source.id}
                data-testid={`data-driver-instance-${source.id}`}
                className="flex items-center gap-2 border-b border-border px-3 py-1.5 last:border-b-0"
              >
                <SourceTypeIcon className="size-4 text-muted-foreground" />
                <button
                  type="button"
                  className="truncate text-sm hover:underline disabled:no-underline"
                  title={source.asset_ref ? t`Open data_source.json` : undefined}
                  disabled={!source.asset_ref}
                  onClick={() => openSourceFile(navigation, source.asset_ref)}
                >
                  {source.name || source.provider}
                </button>
                <span className="text-xs text-muted-foreground">{source.status}</span>
                <span className="ms-auto">
                  <OpenFolderButton path={source.asset_ref} testId={`data-source-folder-${source.id}`} />
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
