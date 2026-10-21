/**
 * The datasets a data source hosts (`"data_source": <name>` in their dataset.json): what a source that holds rows IS,
 * so its simple view lists them -- each with its rows and, while the source is not set up here, why its rows are local.
 */
import { Dataset, type DataSource, ExpressionNode, QueryFilter, QueryRequest } from '@sdk';
import { Plural, Trans } from '@lingui/react/macro';
import { useMemo } from 'react';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { subjectEditorPointer } from '@src/navigation/subject-editor';

export function hostedDatasetsRequest(source: DataSource | null): QueryRequest {
  const clauses = [new ExpressionNode({ op: '$EQ', operands: ['data_source', source?.name ?? ''] })];
  if (source?.project_id) clauses.push(new ExpressionNode({ op: '$EQ', operands: ['project_id', source.project_id] }));
  return new QueryRequest({
    type: Dataset.type,
    query: new QueryFilter({ match: clauses.length > 1 ? new ExpressionNode({ op: '$AND', operands: clauses }) : clauses[0] }),
  });
}

/** The hosted datasets, or null while they load / when the source hosts none (then the page shows what it did). */
export function useHostedDatasets(source: DataSource | null): Dataset[] | null {
  const request = useMemo(() => hostedDatasetsRequest(source), [source?.name, source?.project_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data = [], isSuccess } = useEntitiesQuery<Dataset>(request);
  return isSuccess && source?.name && data.length ? data : null;
}

export function HostedDatasets({ datasets }: { datasets: Dataset[] }) {
  const { navigation } = useDockNavigation();
  const open = async (id: string) => {
    const pointer = await subjectEditorPointer(`dataset-${id}`);
    if (pointer) navigation.openDock(pointer);
  };
  return (
    <section className="rounded-lg border border-border" data-testid="hosted-datasets">
      <h3 className="border-b border-border px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Plural value={datasets.length} one="Hosts # dataset" other="Hosts # datasets" />
      </h3>
      <ul>
        {[...datasets].sort((a, b) => String(a.name).localeCompare(String(b.name))).map((d) => (
          <li key={d.id} className="flex items-baseline gap-3 border-b border-border px-4 py-2 last:border-0">
            <button type="button" className="text-sm text-primary underline-offset-2 hover:underline" onClick={() => void open(d.id)}>
              {d.name}
            </button>
            <span className="text-xs text-muted-foreground">
              <Plural value={d.num_rows ?? 0} one="# row" other="# rows" />
            </span>
            {d.rows_note ? <span className="ms-auto truncate text-xs text-muted-foreground">{d.rows_note}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
