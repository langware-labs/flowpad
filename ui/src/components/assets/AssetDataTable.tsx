import React from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@src/components/ui/table';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from '@src/components/ui/pagination';
import { getColumns } from './columns/columnRegistry';
import type { ColumnActions } from './columns/columnRegistry';
import { scopeTag } from './columns/columnHelpers';
import type { SearchResult } from '@src/hooks/use-asset-search';
import { useClaudeProjectList, getProjectDisplayName } from '@src/hooks/use-claude-projects';
import { projectIdForPath } from './utils';

interface Props {
  results: SearchResult[];
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
  recordType: string;
  onRowClick?: (result: SearchResult) => void;
  onProjectFilter?: (label: string) => void;
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

export function AssetDataTable({ results, total, page, pageSize, onPageChange, recordType, onRowClick, onProjectFilter }: Props) {
  const typeColumns = getColumns(recordType);
  const colActions: ColumnActions = { filterByProject: onProjectFilter };
  const totalPages = Math.ceil(total / pageSize);

  // Build a project_id → display-name lookup so the scope column can render
  // human-readable project names instead of the project_id UUID. The API today
  // returns `project_name: null` on rows, so we resolve here client-side via
  // the same project list that powers `ProjectPickerModal` — uuid5(project:cwd)
  // matches the `project_id` stamped on records by the indexer.
  const { projects } = useClaudeProjectList();
  const projectNameById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) {
      const pid = projectIdForPath(p.cwd || p.name);
      if (pid) m.set(pid, getProjectDisplayName(p));
    }
    return m;
  }, [projects]);

  const renderScope = React.useCallback(
    (r: SearchResult): React.ReactNode => {
      if (r.scope === 'user') return scopeTag('user');
      if (r.scope === 'project') {
        const name = (r.project_name || (r.project_id ? projectNameById.get(r.project_id) : undefined)) ?? r.project_id ?? '';
        return React.createElement(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
          scopeTag('project'),
          name ? React.createElement('span', { style: { fontSize: '12px', color: '#64748b' } }, name) : null,
        );
      }
      return '—';
    },
    [projectNameById],
  );

  const baseColumns = [
    { key: 'name', header: 'Name', render: (r: SearchResult) => r.name || r.uname || r.title || '—' },
    { key: 'status', header: 'Status', render: (r: SearchResult) => r.status || '—' },
    { key: 'scope', header: 'Scope', render: (r: SearchResult) => renderScope(r) },
    { key: 'modified_at', header: 'Modified', render: (r: SearchResult) => formatDate(r.modified_at) },
  ];

  // Merge base cols with per-type cols (deduplicate by key)
  const baseKeys = new Set(baseColumns.map((c) => c.key));
  const allColumns = [
    ...baseColumns,
    ...typeColumns.filter((c) => !baseKeys.has(c.key)),
  ];

  if (results.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
        No results found
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-muted-foreground">
        Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            {allColumns.map((col) => (
              <TableHead key={col.key} style={col.width ? { width: col.width } : undefined}>
                {col.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {results.map((row) => (
            <TableRow
              key={row.record_id}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={onRowClick ? 'cursor-pointer hover:bg-muted/50' : undefined}
            >
              {allColumns.map((col) => (
                <TableCell key={col.key}>{col.render(row, colActions)}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {totalPages > 1 && (
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                onClick={page > 1 ? () => onPageChange(page - 1) : undefined}
                className={page <= 1 ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
              />
            </PaginationItem>
            <PaginationItem>
              <span className="px-3 text-sm">
                Page {page} of {totalPages}
              </span>
            </PaginationItem>
            <PaginationItem>
              <PaginationNext
                onClick={page < totalPages ? () => onPageChange(page + 1) : undefined}
                className={page >= totalPages ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </div>
  );
}
