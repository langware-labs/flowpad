import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Plus, Trash2, Unlink } from 'lucide-react';
import { DataSource, Project, TypeId, type DependencyState } from '@sdk';
import { useEntityBatch } from '@src/components/entity-batch/EntityBatchHydrator';
import { useProjectDependencies } from '@src/hooks/use-project-dependencies';
import { NavigatorSection } from '@src/components/navigator-panel/NavigatorSection';
import { DataSourceDialog } from '@src/components/data-sources/DataSourceDialog';
import { isKnowledgeSource, isMessageDriverSpec, useSourceSpecs } from '@src/components/data-sources/use-source-specs';
import { sourceIcon } from '@src/components/data-sources/source-icon';
import { statusStyle } from '@src/components/data-sources/status-style';
import { healthStyle } from '@src/components/data-sources/health-style';
import { SourceSetupButton } from '@src/components/data-sources/SourceSetupButton';
import { SetupStagesButton } from '@src/components/setup-wizard/SetupStagesButton';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { Dialog } from '@src/components/ui/dialog';
import { SteppedDialogContent } from '@src/components/ui/stepped-dialog';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { notify } from '@src/notifications';
import { Empty, IconButton, ResourceRow } from './parts';

/** Only parse identity here. Dependency membership and paths come from the server. */
function sourceTypeId(state: DependencyState): TypeId | null {
  try {
    const ref = new TypeId(state.typeid || state.source);
    return ref.type === DataSource.type ? ref : null;
  } catch {
    return null;
  }
}

function useDependencySources(states: DependencyState[]) {
  return useEntityBatch<DataSource>(DataSource.type, states.flatMap((state) => {
    const ref = sourceTypeId(state);
    return ref ? [ref.id] : [];
  }));
}

/** Render server-supplied provenance, translating handles to their display labels. */
export function SourceDependencyRows({ states, sources, onOpen, isOpen, onRemove, removing }: {
  states: DependencyState[];
  sources: DataSource[];
  onOpen: (typeid: string) => void;
  isOpen: (typeid: string) => boolean;
  onRemove?: (name: string) => void;
  removing?: string | null;
}) {
  const { t, i18n } = useLingui();
  const { specFor } = useSourceSpecs();
  const label = (state: DependencyState) => {
    const ref = sourceTypeId(state)?.toString();
    return sources.find((source) => source.typeId.toString() === ref)?.name || state.label || state.name;
  };
  return states.map((state, index) => {
    const ref = sourceTypeId(state);
    const source = sources.find((item) => item.id === ref?.id);
    const name = label(state);
    const path = (state.via_path ?? (state.via ? [state.via] : [])).map((handle) => {
      const parent = states.find((item) => item.name === handle);
      return parent ? label(parent) : handle;
    }).join(' → ');
    const provenance = path ? t`Via ${path}` : t`Added directly`;
    const status = source ? i18n._(source.isActive ? healthStyle(source.health).label : statusStyle(source.status).label) : '';
    const resolution = state.state !== 'ready' ? state.reason || state.state : '';
    return <ResourceRow
      key={`${state.source}:${state.name}:${index}`}
      icon={source ? sourceIcon(specFor(source.provider), source.channel) : iconForType(DataSource.type)}
      label={name}
      detail={[provenance, resolution || status].filter(Boolean).join(' · ')}
      selected={!!ref && isOpen(ref.toString())}
      onOpen={() => ref && onOpen(ref.toString())}
      testId={`agent-dependency-source-${ref?.id || state.name}`}
      action={<>
        {source && (source.needsSetup ? <SourceSetupButton source={source} /> : <SetupStagesButton source={source} spec={specFor(source.provider)} />)}
        {!path && onRemove && <IconButton icon={Unlink} label={t`Remove ${name} from agent`} onClick={() => onRemove(state.name)} disabled={!!removing} testId={`agent-dependency-remove-${state.name}`} />}
      </>}
    />;
  });
}

function AddProjectSourceDialog({ project, agent, onClose, onConnect, onAdded }: {
  project: Project;
  agent: TypeId;
  onClose: () => void;
  onConnect: () => void;
  onAdded: () => void;
}) {
  const { t } = useLingui();
  const [candidateIds, setCandidateIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<DataSource | null>(null);
  const [preview, setPreview] = useState<DependencyState[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const alive = useRef(true);
  const connect = useRef(onConnect);
  connect.current = onConnect;
  const { specFor } = useSourceSpecs();
  const candidates = useEntityBatch<DataSource>(DataSource.type, candidateIds);
  const origins = useEntityBatch<Project>(Project.type, candidates.flatMap((source) => source.project_id ? [source.project_id] : []));
  const previewSources = useDependencySources(preview ?? []);
  useEffect(() => {
    alive.current = true;
    void project.dependencyCandidates(agent.toString()).then((ids) => {
      if (alive.current) setCandidateIds(ids.map((id) => new TypeId(id).id));
    }).catch((err: unknown) => { if (alive.current) setError(String(err)); })
      .finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; generation.current += 1; };
  }, [project, agent]);
  const pickable = candidates.filter((source) => isKnowledgeSource(source, specFor(source.provider)));
  const nothingToPick = !loading && !error && candidates.length === candidateIds.length && pickable.length === 0;
  useEffect(() => {
    // Nothing in the project to pick: go straight to connecting a new source, not an empty list.
    if (nothingToPick) connect.current();
  }, [nothingToPick]);
  const pick = async (source: DataSource) => {
    const version = ++generation.current;
    setSelected(source);
    setPreview(null);
    setError('');
    try {
      const result = await project.previewDependencies(agent.toString(), [source.typeId.toString()]);
      if (alive.current && generation.current === version) setPreview(result.dependencies);
    } catch (err) {
      if (alive.current && generation.current === version) setError(err instanceof Error ? err.message : String(err));
    }
  };
  const add = async () => {
    if (!selected || !preview) return;
    setBusy(true);
    setError('');
    try {
      await project.addDependency(selected.typeId.toString(), { asset: agent.toString(), label: selected.name });
      if (!alive.current) return;
      onAdded();
      onClose();
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const back = () => { generation.current += 1; setSelected(null); setPreview(null); setError(''); };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <SteppedDialogContent
      crumbs={[{ label: t`Add data source`, onClick: selected && !busy ? back : undefined }, ...(selected ? [{ label: selected.name }] : [])]}
      description={selected ? t`Included through this source's packages. Changes apply to new sessions.` : t`Choose a data source from this project by name.`}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}><Trans>Cancel</Trans></Button>
        {selected ? <Button onClick={() => void add()} disabled={!preview || busy} data-testid="agent-source-confirm-add"><Trans>Add to agent</Trans></Button>
          : <Button variant="outline" onClick={onConnect}><Trans>Connect new source</Trans></Button>}
      </>}
    >
      {error && <p role="alert" className="mb-3 rounded bg-destructive/10 p-2 text-sm">{error}</p>}
      {selected ? preview ? <SourceDependencyRows states={preview} sources={previewSources} onOpen={() => {}} isOpen={() => false} /> : !error && <Empty><Trans>Reading packages…</Trans></Empty>
        : <>
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t`Search data sources`} aria-label={t`Search data sources`} />
          {loading ? <Empty><Trans>Loading data sources…</Trans></Empty> : !candidateIds.length && !error ? <Empty><Trans>No data sources in this project yet</Trans></Empty> : null}
          {pickable.filter((source) => source.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((source) => <button
            key={source.id} className="mt-2 block w-full rounded border p-3 text-start hover:bg-muted" onClick={() => void pick(source)} data-testid={`agent-source-pick-${source.id}`}
          ><span className="block text-sm font-medium">{source.name}</span><span className="text-xs text-muted-foreground">{origins.find((origin) => origin.id === source.project_id)?.name || source.project_id} · {source.provider} · {source.id.slice(0, 8)}</span></button>)}
        </>}
    </SteppedDialogContent>
  </Dialog>;
}

export function AgentDataSourcesSection({ project, agent, ownedSources, sourcesLoading, onOpen, isOpen, onDelete }: {
  project: Project | null | undefined;
  agent: TypeId | null;
  ownedSources: DataSource[];
  sourcesLoading: boolean;
  onOpen: (typeid: string) => void;
  isOpen: (typeid: string) => boolean;
  onDelete: (source: DataSource) => void;
}) {
  const { t } = useLingui();
  const deps = useProjectDependencies(agent ? project : null, { asset: agent?.toString() });
  const attached = useDependencySources(deps.dependencies);
  const { specFor } = useSourceSpecs();
  const [adding, setAdding] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const sourceStates = deps.dependencies.filter((state) => !!sourceTypeId(state));
  const attachedIds = new Set(sourceStates.map((state) => sourceTypeId(state)?.id));
  const legacy = ownedSources.filter((source) => !attachedIds.has(source.id));
  const remove = async (name: string) => {
    setRemoving(name);
    try { await deps.remove(name); setChanged(true); }
    catch (err) { notify.error({ title: err instanceof Error ? err.message : String(err) }); }
    finally { setRemoving(null); }
  };
  return <>
    <NavigatorSection scope="agent-resources" id="data-sources" label={t`Data sources`} isLoading={sourcesLoading || deps.isLoading} itemCount={sourceStates.length + legacy.length}
      action={<IconButton icon={Plus} label={t`Add data source`} onClick={() => project && agent ? setAdding(true) : setConnecting(true)} testId="agent-resource-add-data-source" />}
      emptyState={<Empty><Trans>Add a project data source to include its packages</Trans></Empty>}
    >
      <SourceDependencyRows states={sourceStates} sources={attached} onOpen={onOpen} isOpen={isOpen} onRemove={(name) => void remove(name)} removing={removing} />
      {legacy.map((source) => <ResourceRow key={source.id} icon={sourceIcon(specFor(source.provider), source.channel)} label={source.name} selected={isOpen(source.typeId.toString())} onOpen={() => onOpen(source.typeId.toString())} testId={`agent-resource-row-${source.typeId.toString()}`}
        action={<>{source.needsSetup ? <SourceSetupButton source={source} /> : <SetupStagesButton source={source} spec={specFor(source.provider)} />}<IconButton icon={Trash2} label={t`Delete ${source.name}`} onClick={() => onDelete(source)} testId={`agent-resource-delete-data-source-${source.id}`} /></>}
      />)}
    </NavigatorSection>
    {deps.error && <p className="px-3 pb-2 text-xs text-destructive" role="alert">{deps.error}</p>}
    {changed && <p className="px-3 pb-2 text-xs text-muted-foreground" role="status"><Trans>Changes apply to new sessions.</Trans></p>}
    {adding && project && agent && <AddProjectSourceDialog key={`${project.id}:${agent.toString()}`} project={project} agent={agent} onClose={() => setAdding(false)} onConnect={() => { setAdding(false); setConnecting(true); }} onAdded={() => { setChanged(true); void deps.refetch(); }} />}
    {connecting && <DataSourceDialog open onOpenChange={setConnecting} owner={agent} only={(spec) => !isMessageDriverSpec(spec)} />}
  </>;
}
