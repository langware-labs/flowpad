import { Project, WebApp, type FSRef } from '@sdk';
import { isHubOnly } from '@sdk/utils/hub-runtime';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Plus, RotateCw, Server, Trash2 } from 'lucide-react';

import { notify } from '@src/notifications';
import { cn } from '@src/lib/utils';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { Button } from '@src/components/ui/button';
import { Switch } from '@src/components/ui/switch';
import { Textarea } from '@src/components/ui/textarea';
import { Input } from '@src/components/ui/input';
import { SEGMENTED_ACTIVE, SEGMENTED_GROUP, SEGMENTED_IDLE } from '@src/components/ui/segmented';
import { useMarkdownContent } from '@src/hooks/use-markdown-content';
import { invalidateGitPreflight } from '@src/hooks/use-git-share-preflight';
import { entityReloadKey } from '@src/utils/entity-reload-key';
import { showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import type { DocumentValue } from '@sdk/fs/AssetDocument';

import { DocumentSaveNotice } from '../DocumentSaveNotice';
import { useNestedHost } from '../nested-host';
import {
  MOUNT_PATTERN,
  addressOf,
  declaredPort,
  effectiveMounts,
  replaceAt,
  servingOf,
  switchServing,
  withPath,
  withPort,
  type Audience,
  type Mount,
  type ProxyServing,
  type Service,
} from './app-fields';
import { AppPlacesColumn } from './AppPlacesColumn';
import { AppSetupTab } from './AppSetupTab';
import { CommitInput, Field, ProxyFields } from './AppServingFields';
import { useAppRunState } from './use-app-run-state';

interface AppEditorProps {
  /** Always resolved — AssetEditorRouter renders this inside an EntityResolutionGate. */
  app: WebApp;
  /** The app's `webapp.json`. */
  mainRef: FSRef;
}

const SEG_BUTTON = 'flex h-6 items-center justify-center rounded-sm px-3 text-xs transition-colors';
const CARD = 'space-y-3 rounded-md border border-border px-3 py-3';

function Segmented<T extends string>({
  options,
  value,
  onChange,
  testId,
}: {
  options: [T, string][];
  value: T;
  onChange: (value: T) => void;
  testId: string;
}) {
  return (
    <div role="radiogroup" className={cn(SEGMENTED_GROUP, 'inline-flex h-8')} data-testid={testId}>
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={key === value}
          className={cn(SEG_BUTTON, key === value ? SEGMENTED_ACTIVE : SEGMENTED_IDLE)}
          onClick={() => key !== value && onChange(key)}
          data-testid={`${testId}-${key}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * The app page: its DEFINITION (`webapp.json`) on the left, where it RUNS on the right — the agent
 * editor's frame (`AgentProfileEditor`). Every field saves on leave through the same revision-checked
 * document patch; the backend validates it against `WebappManifestSpec` and refuses a bad value. What
 * changes how a running process starts (its command, its port) waits for Restart, and the header says so.
 */
export function AppEditor({ app, mainRef }: AppEditorProps) {
  const { t } = useLingui();
  const hub = isHubOnly();
  const appRef = useRef(app);
  appRef.current = app;
  const { navigation } = useDockNavigation();
  const nested = useNestedHost();
  const content = useMarkdownContent(mainRef, { autoSave: false, reloadKey: entityReloadKey(app.updated_date) });
  const contentRef = useRef(content);
  contentRef.current = content;
  const writeQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const [openService, setOpenService] = useState<number | null>(null);
  const [tab, setTab] = useState<'definition' | 'setup' | 'deployments'>('definition');
  const run = useAppRunState(app.project_id, app.name, !hub);
  const { reload, restart: restartApp } = run;

  const fields = content.typedFields as Record<string, unknown>;
  const title = (fields.title as string | undefined) ?? '';
  const description = (fields.description as string | undefined) ?? '';
  const services = (fields.services as Service[] | undefined) ?? [];
  const mounts = effectiveMounts(fields.mounts as Mount[] | undefined, services);

  const save = useCallback(
    (patch: Record<string, DocumentValue | undefined>): Promise<boolean> => {
      const current = contentRef.current;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) current.dropField(key);
        else current.setField(key, value);
      }
      const operation = writeQueueRef.current.then(async () => {
        const saved = await contentRef.current.save();
        if (saved) {
          appRef.current.markEdit();
          invalidateGitPreflight(appRef.current.typeId);
          // Only how it runs can change what a restart would apply.
          if ('mounts' in patch || 'services' in patch) reload();
        }
        return saved;
      });
      writeQueueRef.current = operation;
      return operation;
    },
    [reload],
  );

  // The two lists are typed here and plain JSON to the document: one cast each.
  const writeMount = (index: number, next: Mount) =>
    save({ mounts: replaceAt(mounts, index, next) as unknown as DocumentValue });
  const writeServices = (next: Service[]) =>
    save({ services: next.length ? (next as unknown as DocumentValue) : undefined });
  const saveMount = (index: number, next: Mount) => void writeMount(index, next);
  const saveServices = (next: Service[]) => void writeServices(next);

  const restart = useCallback(async () => {
    const answer = await restartApp();
    if (answer.ok) notify.success({ title: t`${appRef.current.displayName} restarted`, message: answer.detail });
    else notify.error({ title: t`Could not start ${appRef.current.displayName}`, message: answer.detail });
  }, [restartApp, t]);

  /** "Use any free port": the process whose required port is held stops requiring it, then restarts. */
  const anyFreePort = async (process: string) => {
    const relax = <S extends ProxyServing>(serving: S): S => {
      const port = declaredPort(serving);
      return withPort(serving, port && { ...port, required: false }) as S;
    };
    const page = mounts.findIndex((mount) => servingOf(mount).type === 'proxy');
    const service = services.findIndex((one) => one.name === process);
    const saved =
      process === 'page'
        ? await writeMount(page, { ...mounts[page], serving: relax(servingOf(mounts[page]) as ProxyServing) })
        : await writeServices(
            replaceAt(services, service, { ...services[service], serving: relax(services[service].serving) }),
          );
    if (saved) await restart();
  };

  const onDelete = useCallback(() => {
    showDeleteAssetModal({
      name: appRef.current.displayName || appRef.current.name || t`this app`,
      onConfirm: async () => {
        const current = appRef.current;
        // An app is its folder: the row alone would come back on the next index. Stop what runs from
        // it first, so nothing is left serving a folder that is gone.
        if (current.project_id) await Project.stopApp(current.project_id, current.name).catch(() => undefined);
        await mainRef.parent.delete();
        await current.delete();
      },
      onAfterDelete: () => (nested ? nested.close() : navigation.openDock(DockPointer.forAssetList(WebApp.type))),
    });
  }, [mainRef, navigation, nested, t]);

  if (content.isLoading) return <Loader2 className="m-4 h-5 w-5 animate-spin" />;
  const definitionError = content.loadError;
  const AppIcon = iconForType(WebApp.type);
  const audienceLabel = (audience: Audience | undefined) => (audience === 'admin' ? t`Admins` : t`Users`);
  const first = mounts[0];
  const served = first ? `${audienceLabel(first.audience)} · ${addressOf(first, app.name)}` : null;
  const { running } = run;
  const failed = !!run.conflict;
  const pending = run.changes.length;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="app-editor">
      <DocumentSaveNotice {...content} />
      {/* ── header: identity + run state ─────────────────────────────── */}
      <div className="flex shrink-0 flex-wrap items-center gap-4 border-b border-border px-6 py-5">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground shadow-sm">
          <AppIcon className="h-7 w-7" />
        </div>
        <div className="min-w-[14rem] flex-1">
          <CommitInput
            mono={false}
            value={title}
            onCommit={(v) => void save({ title: v })}
            readOnly={hub}
            placeholder={app.name}
            aria-label={t`App title`}
            data-testid="app-title"
            className="h-auto min-w-0 flex-1 border-0 bg-transparent px-0 text-2xl font-semibold shadow-none focus-visible:ring-0"
          />
          <div
            className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
            data-testid="app-status"
          >
            {served && <span>{served}</span>}
            {hub ? (
              <Trans>Published version — edit it on the author's computer</Trans>
            ) : failed ? (
              <span className="rounded-full bg-destructive/15 px-2 py-0.5 font-medium text-destructive">
                <Trans>Not running</Trans>
              </span>
            ) : pending > 0 ? (
              <span
                className="rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-400"
                title={run.changes.join('\n')}
                data-testid="app-pending"
              >
                {pending === 1 ? t`1 change not applied` : t`${pending} changes not applied`}
              </span>
            ) : running ? (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-medium text-emerald-700 dark:text-emerald-400">
                <Trans>Running</Trans>
              </span>
            ) : null}
          </div>
        </div>
        {!hub && pending > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={run.busy}
            onClick={() => void restart()}
            data-testid="app-restart"
          >
            {run.busy ? (
              <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCw className="me-1.5 h-3.5 w-3.5" />
            )}
            <Trans>Restart</Trans>
          </Button>
        )}
        {!hub && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onDelete}
            aria-label={t`Delete app`}
            title={t`Delete app`}
            data-testid="app-delete"
            className="shrink-0 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* ── tabs: the definition, how it comes up (setup), where it runs ── */}
      <div className="flex items-center gap-1 border-b px-6" role="tablist" data-testid="app-editor-tabs">
        {(
          [
            ['definition', t`Definition`],
            ['setup', t`Setup`],
            ['deployments', t`Deployments`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-testid={`app-tab-${id}`}
            onClick={() => setTab(id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              tab === id ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'definition' && (
          <section className="flex min-h-0 flex-col gap-5 px-6 py-5" aria-labelledby="app-definition">
            <fieldset disabled={hub || !!definitionError} className="contents" data-testid="app-definition-fields">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="app-definition" className="text-sm font-semibold">
                  <Trans>Definition</Trans>
                </h2>
                <span className="text-xs text-muted-foreground">
                  <Trans>webapp.json · shared by every place</Trans>
                </span>
              </div>
              {definitionError && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  <Trans>Could not load the app's definition: {definitionError.message}</Trans>
                </div>
              )}

              <Field label={<Trans>Description</Trans>}>
                <Textarea
                  value={description}
                  onChange={(e) => content.setField('description', e.target.value)}
                  onBlur={() => void save({ description: description.trim() })}
                  placeholder={t`What is this app for?`}
                  aria-label={t`Description`}
                  data-testid="app-description"
                  className="min-h-0 resize-none text-sm"
                  rows={2}
                />
              </Field>

              <label className="flex items-start gap-2 text-sm" data-testid="app-report-errors">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={(fields.report_errors as boolean | undefined) !== false}
                  onChange={(e) => void save({ report_errors: e.target.checked })}
                />
                <span>
                  <Trans>Report page errors</Trans>
                  <span className="block text-xs text-muted-foreground">
                    <Trans>
                      The app opens only when its page loads without errors; an error starts recovery (Setup tab).
                    </Trans>
                  </span>
                </span>
              </label>

              {mounts.map((mount, index) => {
                const serving = servingOf(mount);
                const label = mounts.length > 1 ? ` — ${addressOf(mount, app.name)}` : '';
                return (
                  <div key={index} className="contents">
                    <div className={CARD} data-testid={`app-mount-${index}-audience`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">
                          <Trans>Who opens it</Trans>
                          {label}
                        </span>
                        <Segmented<Audience>
                          options={[
                            ['app', t`Users`],
                            ['admin', t`Admins`],
                          ]}
                          value={mount.audience ?? 'app'}
                          onChange={(audience) => saveMount(index, { ...mount, audience })}
                          testId={`app-mount-${index}-audience-switch`}
                        />
                      </div>
                      <Field label={<Trans>Address</Trans>}>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm text-muted-foreground">/</span>
                          <CommitInput
                            value={mount.path ?? ''}
                            disabled={mount.path === ''}
                            placeholder={app.name}
                            aria-label={t`Address`}
                            data-testid={`app-mount-${index}-path`}
                            isValid={(v) => {
                              if (MOUNT_PATTERN.test(v)) return true;
                              notify.error({
                                title: t`Not an address`,
                                message: t`Use letters, digits, '.', '_', '~' or '-', starting with a letter or digit.`,
                              });
                              return false;
                            }}
                            onCommit={(v) => saveMount(index, withPath(mount, v || undefined))}
                          />
                          <span className="font-mono text-sm text-muted-foreground">/</span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {mount.audience === 'admin'
                            ? t`The project's operators open it at ${addressOf(mount, app.name)}.`
                            : t`End users open it at ${addressOf(mount, app.name)}.`}
                        </p>
                      </Field>
                      <div className="flex items-center justify-between">
                        <span className="text-sm">
                          <Trans>Home page — opens at the root</Trans>
                        </span>
                        <Switch
                          checked={mount.path === ''}
                          onCheckedChange={(home) => saveMount(index, withPath(mount, home ? '' : undefined))}
                          aria-label={t`Home page`}
                          data-testid={`app-mount-${index}-home`}
                        />
                      </div>
                    </div>

                    <div className={CARD} data-testid={`app-mount-${index}-serving`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">
                          <Trans>How it runs</Trans>
                          {label}
                        </span>
                        <Segmented<'proxy' | 'static'>
                          options={[
                            ['proxy', t`Run a command`],
                            ['static', t`Serve a folder`],
                          ]}
                          value={serving.type}
                          onChange={(to) => saveMount(index, { ...mount, serving: switchServing(serving, to) })}
                          testId={`app-mount-${index}-serving-switch`}
                        />
                      </div>
                      {serving.type === 'proxy' ? (
                        <ProxyFields
                          serving={serving}
                          onChange={(next) => saveMount(index, { ...mount, serving: next })}
                          testId={`app-mount-${index}-proxy`}
                        />
                      ) : (
                        <Field label={<Trans>Folder</Trans>}>
                          <CommitInput
                            value={serving.root ?? ''}
                            placeholder={typeof fields.build === 'string' ? fields.build : '.'}
                            aria-label={t`Folder`}
                            data-testid={`app-mount-${index}-root`}
                            onCommit={(v) => saveMount(index, { ...mount, serving: { type: 'static', root: v } })}
                          />
                          <p className="mt-1 text-xs text-muted-foreground">
                            <Trans>Relative to the app folder. Empty: its build folder.</Trans>
                          </p>
                        </Field>
                      )}
                    </div>
                  </div>
                );
              })}

              <div className={CARD} data-testid="app-services">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    <Trans>Services</Trans>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    data-testid="app-add-service"
                    onClick={() => {
                      const taken = new Set(services.map((service) => service.name));
                      let n = services.length + 1;
                      while (taken.has(`service-${n}`)) n += 1;
                      saveServices([
                        ...services,
                        {
                          name: `service-${n}`,
                          protocol: { spec_kind: 'api.rest' },
                          serving: { type: 'proxy', start_cmd: '' },
                        },
                      ]);
                      setOpenService(services.length);
                    }}
                  >
                    <Plus className="me-1.5 h-3.5 w-3.5" />
                    <Trans>Add service</Trans>
                  </Button>
                </div>
                {services.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    <Trans>No services — an API the app brings along runs as its own service.</Trans>
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y rounded-md border">
                    {services.map((service, index) => {
                      const open = openService === index;
                      const port = declaredPort(service.serving);
                      return (
                        <li key={`${service.name}-${index}`} data-testid={`app-service-${service.name}`}>
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 px-3 py-2 text-start hover:bg-muted/60"
                            onClick={() => setOpenService(open ? null : index)}
                            aria-expanded={open}
                          >
                            <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate font-mono text-sm">{service.name}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {service.protocol?.spec_kind === 'api.rest' ? t`REST API` : service.protocol?.spec_kind}
                              {port ? ` · :${port.port}` : ''}
                              {port && port.required !== false ? t` · only this port` : ''}
                            </span>
                            {open ? (
                              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                            )}
                          </button>
                          {open && (
                            <div className="space-y-3 border-t border-border bg-muted/20 px-3 py-3">
                              <Field label={<Trans>Name</Trans>}>
                                <CommitInput
                                  value={service.name}
                                  aria-label={t`Service name`}
                                  onCommit={(name) =>
                                    name && saveServices(replaceAt(services, index, { ...service, name }))
                                  }
                                />
                              </Field>
                              <ProxyFields
                                serving={service.serving}
                                onChange={(serving) =>
                                  saveServices(replaceAt(services, index, { ...service, serving }))
                                }
                                testId={`app-service-${service.name}-proxy`}
                              />
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 text-muted-foreground hover:text-destructive"
                                onClick={() => {
                                  setOpenService(null);
                                  saveServices(services.filter((_, i) => i !== index));
                                }}
                              >
                                <Trash2 className="me-1.5 h-3.5 w-3.5" />
                                <Trans>Remove service</Trans>
                              </Button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <details className="group rounded-md border border-border" data-testid="app-more">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium">
                  <ChevronRight className="h-3.5 w-3.5 transition group-open:rotate-90" />
                  <Trans>More</Trans>
                  <span className="text-xs font-normal text-muted-foreground">
                    <Trans>name · kind · build folder · file</Trans>
                  </span>
                </summary>
                <div className="flex flex-col gap-4 border-t border-border px-3 py-3 text-sm">
                  <Field label={<Trans>Name — the app's folder name, used to address it</Trans>}>
                    <code className="font-mono" data-testid="app-name">
                      {app.name}
                    </code>
                  </Field>
                  <Field label={<Trans>Kind</Trans>}>
                    <code className="font-mono">
                      {typeof fields.kind === 'string' ? fields.kind : 'application.web'}
                    </code>
                  </Field>
                  <Field label={<Trans>Build folder — the subfolder that is served</Trans>}>
                    <CommitInput
                      value={typeof fields.build === 'string' ? fields.build : '.'}
                      aria-label={t`Build folder`}
                      onCommit={(v) => void save({ build: v || '.' })}
                    />
                  </Field>
                  <Field label={<Trans>File</Trans>}>
                    <Input readOnly value={mainRef.path ?? 'webapp.json'} className="font-mono text-xs" />
                  </Field>
                </div>
              </details>
            </fieldset>
          </section>
        )}
        {tab === 'setup' && <AppSetupTab app={app} />}
        {tab === 'deployments' && (
          <div className="px-6 py-5">
            {hub ? (
              <p className="text-sm text-muted-foreground">
                <Trans>Where the app runs is shown on the computer that runs it.</Trans>
              </p>
            ) : (
              <AppPlacesColumn
                run={run}
                served={served}
                onRestart={() => void restart()}
                onAnyFreePort={(p) => void anyFreePort(p)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
