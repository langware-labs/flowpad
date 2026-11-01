import type { ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Button } from '@src/components/ui/button';
import { CopyButton } from '@src/components/ui/copy-button';
import type { AppDisplay } from '@src/hooks/flow-hooks/useAppDisplay';
import type { AppLifecycle } from './useAppLifecycle';
import type { WebApp } from '@sdk';
import { dataContext } from '@sdk';
import { CommitInput } from '@src/components/assets/editor/app-profile/AppServingFields';
import { WebAppIconPicker } from './WebAppIconPicker';
import { AppOpenInToggle, appOpenIn, openInPatch } from './AppOpenInToggle';
import { useWebAppManifest } from './use-webapp-manifest';

export interface AppInfo {
  display: Pick<AppDisplay, 'src' | 'runtime' | 'available' | 'endpoint'>;
  lifecycle: Pick<AppLifecycle, 'app' | 'record'>;
}

function pairs(map: Record<string, number> | undefined): string {
  return Object.entries(map ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join(', ');
}

/** Every row is [label, value]; an empty value is not shown. */
export function appInfoRows({ display, lifecycle }: AppInfo): [ReactNode, string][] {
  const { src, runtime, available, endpoint } = display;
  const { app, record } = lifecycle;
  const rows: [ReactNode, string][] = [
    [<Trans>Name</Trans>, app?.getDisplayName() ?? app?.name ?? ''],
    [<Trans>Description</Trans>, app?.description ?? ''],
    [<Trans>Kind</Trans>, app?.kind ?? ''],
    [<Trans>Address</Trans>, src],
    [<Trans>Folder</Trans>, app?.folder ?? ''],
    [<Trans>Runtime</Trans>, runtime ? [runtime, ...available.filter((r) => r !== runtime)].join(' · ') : ''],
    [<Trans>Served by</Trans>, endpoint?.backendLabel ?? ''],
    [<Trans>Mount</Trans>, endpoint?.mount ?? ''],
    [<Trans>Build folder</Trans>, app?.build ?? ''],
    [<Trans>State</Trans>, record ? [record.state, record.detail].filter(Boolean).join(' — ') : ''],
    [<Trans>Ports</Trans>, pairs(record?.ports)],
    [<Trans>Processes (pid)</Trans>, pairs(record?.pids)],
    [<Trans>Since</Trans>, record?.since ?? ''],
    [<Trans>Checked</Trans>, record?.checked_at ?? ''],
    [<Trans>Failure</Trans>, record?.failure ? JSON.stringify(record.failure) : ''],
    [<Trans>Project id</Trans>, app?.project_id ?? endpoint?.project_id ?? ''],
    [<Trans>App id</Trans>, app?.id ?? endpoint?.webapp_id ?? ''],
    [<Trans>Artifact id</Trans>, endpoint?.artifact_id ?? ''],
    [<Trans>Endpoint id</Trans>, endpoint?.id ?? ''],
  ];
  return rows.filter(([, value]) => value !== '');
}

/** The app's name and icon, edited in place — saved to its `webapp.json`. Mounted only while the panel is open. */
function AppIdentity({ app }: { app: WebApp }) {
  const { t } = useLingui();
  const { content, save } = useWebAppManifest(app);
  const readOnly = !dataContext.caps.localFiles || content.isLoading || !content.typedFields;
  return (
    <div className="mb-3 flex items-center gap-2 border-b pb-3" data-testid="webapp-info-identity">
      <WebAppIconPicker
        app={app}
        disabled={readOnly}
        onChange={(icon) => void save({ icon })}
        testId="webapp-info-icon"
        className="size-9 rounded-md border"
        iconClassName="size-5"
      />
      <CommitInput
        mono={false}
        value={app.title ?? ''}
        placeholder={app.name}
        readOnly={readOnly}
        onCommit={(title) => void save({ title: title || undefined })}
        aria-label={t`App name`}
        data-testid="webapp-info-name"
        className="h-9 text-sm font-medium"
      />
      <AppOpenInToggle
        value={appOpenIn(app)}
        disabled={readOnly}
        onChange={(choice) => void save(openInPatch(choice))}
      />
    </div>
  );
}

/** An (i) button showing everything known about the displayed app. */
export function AppInfoPopover(info: AppInfo) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="icon" variant="ghost" className="size-7 shrink-0" data-testid="webapp-info">
          <Info className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[32rem] max-w-[90vw] p-3" data-testid="webapp-info-panel">
        {info.lifecycle.app && <AppIdentity app={info.lifecycle.app} />}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
          {appInfoRows(info).map(([label, value], index) => (
            <div key={index} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="flex min-w-0 items-start gap-1.5">
                <span className="break-all font-mono">{value}</span>
                <CopyButton value={value} />
              </dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}
