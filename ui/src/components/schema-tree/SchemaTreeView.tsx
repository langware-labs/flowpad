/**
 * The schema tree — what data a project holds, top to bottom.
 *
 * On the left a tree whose roots are projects: the schemas each one defines, every schema unfolding
 * to the kinds its fields name (`uses` a row another dataset keeps, or holds the value `inside`),
 * then the project's data sources. On the right the card of what is selected: where it is defined,
 * the dataset that keeps its rows, what uses it, its fields. A kind named in the card is a link:
 * following it moves the tree and the card together.
 *
 * URL-first: the project is the dock's SCOPE and the selection its pointer
 * (`schema-tree-pointer.ts`). A row or a link only navigates; what is shown is read back from
 * `currentDock`. Unfolding is the only local state.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DataSource, enumValues, linkTargets, Project, unwrap, type SchemaNode, type SchemaUse, type Shape } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { openSource } from '@src/components/data-sources/data-sources-pointer';
import { errorMessage } from '@src/lib/error-message';
import { DockPointer } from '@src/navigation/DockPointer';
import { subjectEditorPointer } from '@src/navigation/subject-editor';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useContext } from '@src/hooks/useContext';
import { cn } from '@src/lib/utils';
import {
  bareKind, DATA_SCHEMA_TYPE, homeOf, loadSchemaRoots, nodeOf, pathAfterLink, usedBy, type SchemaRoot,
} from './schema-tree-model';
import { parseSchemaTreePointer, SOURCE_SEGMENT } from './schema-tree-pointer';

/** A tree row's key: its project, then the kinds down to it. */
const rowKey = (rootId: string, path: string[]) => `${rootId}|${path.join('/')}`;
const LINK = 'cursor-pointer text-primary underline underline-offset-2 hover:opacity-80';

export function SchemaTreeView() {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();
  const pointer = currentDock?.pointer ?? '';
  const path = useMemo(() => parseSchemaTreePointer(pointer), [pointer]);
  // The project is the address's scope; an address without one shows the current project's.
  const { project } = useContext();
  const projectId = currentDock?.scopeProjectId ?? project?.id ?? '';

  const [model, setModel] = useState<SchemaRoot[] | null>(null);
  const [failure, setFailure] = useState('');
  useEffect(() => {
    let live = true;
    setModel(null);
    setFailure('');
    if (!projectId) return;
    loadSchemaRoots(projectId)
      .then((roots) => live && setModel(roots))
      .catch((error) => live && setFailure(errorMessage(error, t`The schemas could not be read.`)));
    return () => {
      live = false;
    };
  }, [projectId, t]);

  // Unfolding: the selection and what leads to it are open, unless a row was folded or unfolded by hand.
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(new Map());
  const selected = rowKey(projectId, path);
  const unfolded = (k: string) => folds.get(k) ?? (selected === k || selected.startsWith(`${k}/`));
  const toggle = (k: string) => setFolds((was) => new Map(was).set(k, !unfolded(k)));
  const select = (rootId: string, to: string[]) => navigation.openDock(DockPointer.forSchemaTree(rootId, to));

  if (!projectId) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        <Trans>Open a project to see its schemas.</Trans>
      </p>
    );
  }
  if (failure) return <p className="p-6 text-sm">{failure}</p>;
  if (!model) return <p className="p-6 text-sm text-muted-foreground">{t`Reading the schemas…`}</p>;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[minmax(220px,300px)_minmax(0,1fr)]" data-testid="schema-tree">
      <nav
        aria-label={t`Schema tree`}
        className="max-h-[45vh] overflow-auto border-b border-border p-2 md:max-h-none md:border-b-0 md:border-r"
      >
        {model.map((root) => (
          <SchemaRootRows key={root.id} root={root} model={model} selected={selected} unfolded={unfolded} toggle={toggle} select={select} />
        ))}
      </nav>
      <article className="min-w-0 overflow-auto px-6 pb-12 pt-5 text-sm" data-testid="schema-tree-card">
        <SchemaCard model={model} projectId={projectId} path={path} select={(to) => select(projectId, to)} />
      </article>
    </div>
  );
}

interface TreeProps {
  model: SchemaRoot[];
  selected: string;
  unfolded: (key: string) => boolean;
  toggle: (key: string) => void;
  select: (rootId: string, to: string[]) => void;
}

function Row({
  rootId, at, label, type, how, foldable, mono, strong, selected, unfolded, toggle, select,
}: Omit<TreeProps, 'model'> & { rootId: string; at: string[]; label: string; type: string; how?: SchemaUse['held']; foldable?: boolean; mono?: boolean; strong?: boolean }) {
  const { t } = useLingui();
  const Icon = iconForType(type);
  const k = rowKey(rootId, at);
  const open = foldable && unfolded(k);
  return (
    <div
      className={cn('flex items-center gap-1 rounded px-1 hover:bg-accent/60', k === selected && 'bg-accent')}
      data-path={k}
      aria-current={k === selected ? 'true' : undefined}
    >
      {foldable ? (
        <button type="button" aria-label={open ? t`Fold` : t`Unfold`} aria-expanded={open} className="text-muted-foreground" onClick={() => toggle(k)}>
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left" onClick={() => select(rootId, at)}>
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className={cn('truncate', mono && 'font-mono text-xs', strong && 'font-semibold')}>{label}</span>
      </button>
      {how && <span className="shrink-0 text-[11px] text-muted-foreground">{how === 'inside' ? t`inside` : t`uses`}</span>}
    </div>
  );
}

function KindRows({
  rootId, kind, at, how, ...tree
}: TreeProps & { rootId: string; kind: string; at: string[]; how?: SchemaUse['held'] }) {
  const node = nodeOf(tree.model, kind);
  // A kind already on the path (one that names itself) is not unfolded again.
  const uses = node && !at.slice(0, -1).includes(kind) ? node.uses : [];
  return (
    <li>
      <Row {...tree} rootId={rootId} at={at} label={node?.name ?? bareKind(kind)} type={DATA_SCHEMA_TYPE} how={how} foldable={uses.length > 0} mono />
      {uses.length > 0 && tree.unfolded(rowKey(rootId, at)) && (
        <ul className="ml-4 border-l border-border pl-1">
          {uses.map((use) => (
            <KindRows key={use.kind} {...tree} rootId={rootId} kind={use.kind} at={[...at, use.kind]} how={use.held} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SchemaRootRows({ root, ...tree }: TreeProps & { root: SchemaRoot }) {
  const group = 'px-6 pb-0.5 pt-2.5 text-[11px] uppercase tracking-wide text-muted-foreground';
  return (
    <div>
      <Row {...tree} rootId={root.id} at={[]} label={root.name} type={Project.type} strong />
      <ul className="ml-4 border-l border-border pl-1">
        {root.schemas.length > 0 && <li className={group}><Trans>Schemas</Trans></li>}
        {root.schemas.map((node) => (
          <KindRows key={node.kind} {...tree} rootId={root.id} kind={node.kind} at={[node.kind]} />
        ))}
        {root.sources.length > 0 && <li className={group}><Trans>Data sources</Trans></li>}
        {root.sources.map((source) => (
          <li key={source.id}>
            <Row {...tree} rootId={root.id} at={[SOURCE_SEGMENT + source.id]} label={source.name} type={DataSource.type} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── the card ──────────────────────────────────────────────────────────────────

function SchemaCard({
  model, projectId, path, select,
}: { model: SchemaRoot[]; projectId: string; path: string[]; select: (to: string[]) => void }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const root = model.find((r) => r.id === projectId) ?? model[0];
  const last = path[path.length - 1] ?? '';
  const source = last.startsWith(SOURCE_SEGMENT) ? root?.sources.find((s) => SOURCE_SEGMENT + s.id === last) : undefined;
  const node = path.length && !source ? nodeOf(model, last) : undefined;

  const kindLink = (kind: string) => {
    const target = nodeOf(model, kind);
    if (!target) return <span key={kind} className="font-mono text-xs">{bareKind(kind)}</span>;
    return (
      <button key={kind} type="button" data-kind={kind} className={cn(LINK, 'font-mono text-xs', !target.dataset && 'decoration-dotted')} onClick={() => select(pathAfterLink(model, path, kind))}>
        {target.name}
      </button>
    );
  };
  const kindLinks = (nodes: SchemaNode[]) => <span className="flex flex-wrap gap-x-3.5 gap-y-1">{nodes.map((n) => kindLink(n.kind))}</span>;
  const openDataset = async (id: string) => {
    const pointer = await subjectEditorPointer(`dataset-${id}`);
    if (pointer) navigation.openDock(pointer);
  };

  const holds = (shape: Shape | null): ReactNode => {
    if (shape == null) return t`anything`;
    if (Array.isArray(shape)) return <>{t`list of`} {holds(shape[0])}</>;
    if (typeof shape === 'object') return `${t`group`}: ${Object.keys(shape).join(', ')}`;
    const values = enumValues(shape);
    if (values) return values.join(' | ');
    const kinds = linkTargets(shape);
    if (!kinds) {
      const word = unwrap(shape).base as string;
      return word === 'string' ? t`text` : word === 'int' || word === 'float' ? t`number` : word === 'bool' ? t`yes / no` : word;
    }
    return (
      <>
        {kinds.length > 1 && <>{t`one of`} </>}
        {kinds.map((kind, i) => (
          <span key={kind}>{i > 0 && ', '}{kindLink(kind)}</span>
        ))}
      </>
    );
  };

  if (!root) return <p className="text-muted-foreground">{t`No project to show.`}</p>;

  if (source) {
    const feeds = root.schemas.filter((n) => n.dataset?.source_id === source.id);
    return (
      <>
        <Head title={source.name} tag={t`data source`} />
        <Facts rows={[
          [t`Defined in`, root.name],
          [t`Type`, source.provider],
          [t`Feeds`, feeds.length ? kindLinks(feeds) : t`no dataset`],
          [t`Open`, <button type="button" data-open={`data_source-${source.id}`} className={LINK} onClick={() => openSource(navigation, source.id)}>{t`Open the data source`}</button>],
        ]} />
      </>
    );
  }

  if (!node) {
    const rows = root.schemas.reduce((n, k) => n + (k.dataset?.rows ?? 0), 0);
    const datasets = root.schemas.filter((k) => k.dataset).length;
    return (
      <>
        <Head title={root.name} tag={t`project`} />
        <Facts rows={[
          [t`Folder`, root.folder],
          [t`Holds`, [
            t`${root.schemas.length} schemas`, t`${datasets} datasets`, t`${rows} rows`,
            root.sources.length === 1 ? t`1 data source` : t`${root.sources.length} data sources`,
          ].join(' · ')],
        ]} />
        <Section>{t`Schemas defined here`}</Section>
        {root.schemas.length ? kindLinks(root.schemas) : <p className="text-muted-foreground">{t`This project defines no schema.`}</p>}
      </>
    );
  }

  const home = homeOf(model, node.kind)!;
  const feeder = node.dataset?.source_id ? home.sources.find((s) => s.id === node.dataset!.source_id) : undefined;
  const users = usedBy(model, node.kind);
  const count = node.dataset?.rows ?? 0;
  return (
    <>
      {path.length > 1 && (
        <div className="mb-1.5 font-mono text-xs text-muted-foreground" data-testid="schema-tree-crumbs">
          {path.map((k) => nodeOf(model, k)?.name ?? bareKind(k)).join('  ›  ')}
        </div>
      )}
      <Head title={node.name} tag={node.subkind === 'dataset' ? t`dataset schema` : t`schema`} mono />
      <p className="my-1.5 text-muted-foreground">{node.description}</p>
      <Facts rows={[
        [t`Kind`, <span className="font-mono text-xs">{node.kind}</span>],
        [t`Defined in`, `${home.name} · ${node.folder}/`],
        [t`Dataset`, node.dataset ? (
          <button type="button" data-open={`dataset-${node.dataset.id}`} className={LINK} onClick={() => void openDataset(node.dataset!.id)}>
            {node.dataset.title} · {count === 1 ? t`1 row` : t`${count} rows`}
          </button>
        ) : t`none of its own · stored inside the rows of the schema that uses it`],
        [t`Data source`, !node.dataset ? undefined : feeder ? (
          <button type="button" data-open={`data_source-${feeder.id}`} className={LINK} onClick={() => openSource(navigation, feeder.id)}>{feeder.name}</button>
        ) : node.dataset.source_id ? t`a source this project does not list` : t`none · written by hand`],
        [t`Used by`, users.length ? kindLinks(users) : t`nothing`],
      ]} />
      <Section>{node.subkind === 'dataset' ? t`Example slots` : t`Fields`}</Section>
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-xs font-medium text-muted-foreground">
            <th className="py-1 pr-3 font-medium">{t`Field`}</th>
            <th className="py-1 pr-3 font-medium">{t`Holds`}</th>
            <th />
            <th className="py-1 font-medium">{t`Meaning`}</th>
          </tr>
        </thead>
        <tbody>
          {node.fields.map((field) => (
            <tr key={field.name} data-field={field.name} className="border-t border-border align-top">
              <td className="py-1.5 pr-3 font-mono text-xs">{field.name}</td>
              <td className="py-1.5 pr-3">{holds(field.shape)}</td>
              <td className="py-1.5 pr-3 text-muted-foreground">{field.required ? '' : t`optional`}</td>
              <td className="py-1.5 text-muted-foreground">{field.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {node.rules.length > 0 && (
        <>
          <Section>{t`Rules`}</Section>
          <ul className="list-disc pl-5 text-muted-foreground" data-testid="schema-tree-rules">
            {node.rules.map((rule) => {
              // a rule is `same` (two link paths name one row) or `unique` (no two rows share the fields)
              const formula = rule.same ? rule.same.join(' = ') : `unique(${(rule.unique ?? []).join(', ')})`;
              return <li key={formula}>{rule.description || formula}</li>;
            })}
          </ul>
        </>
      )}
    </>
  );
}

function Head({ title, tag, mono }: { title: string; tag: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
      <h1 className={cn('text-xl font-semibold', mono && 'font-mono')}>{title}</h1>
      <span className="rounded-full bg-secondary px-2 py-px text-[11px] text-muted-foreground">{tag}</span>
    </div>
  );
}

function Section({ children }: { children: ReactNode }) {
  return <h2 className="mb-1.5 mt-5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h2>;
}

function Facts({ rows }: { rows: [string, ReactNode | undefined][] }) {
  return (
    <dl className="mt-2.5 grid grid-cols-[max-content_1fr] gap-x-3.5 gap-y-1">
      {rows.filter(([, value]) => value != null && value !== '').map(([name, value]) => (
        <div key={name} className="contents">
          <dt className="text-muted-foreground">{name}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
