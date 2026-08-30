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
import type { ColumnActions, ColumnDef } from './columns/columnRegistry';
import { scopeTag } from './columns/columnHelpers';
import type { SearchResult } from '@src/hooks/use-asset-search';
import { useProjectList, getProjectDisplayName } from '@src/hooks/use-claude-projects';
import { recordProjectIdForPath } from './utils';
import { useContext } from '@src/hooks/useContext';
import { fsManager } from '@sdk';

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
  const { computeNode } = useContext();

  // Resolve the folder to reveal externally for a row: parent directory of the
  // asset's source path. Falls back through the same fields the backend uses
  // when populating asset_ref.
  const folderPathForRow = React.useCallback((r: SearchResult): string | null => {
    const raw = r.asset_ref || r.file_path || r.work_dir || '';
    if (!raw) return null;
    const trimmed = raw.replace(/\/+$/, '');
    if (!trimmed) return null;
    const lastSlash = trimmed.lastIndexOf('/');
    if (lastSlash <= 0) return trimmed;
    return trimmed.slice(0, lastSlash);
  }, []);

  const openScopeFolder = React.useCallback(async (r: SearchResult) => {
    if (!computeNode?.typeId) return;
    const folder = folderPathForRow(r);
    if (!folder) return;
    try {
      await fsManager.open(computeNode.typeId, folder.replace(/^\//, ''));
    } catch (err) {
      console.error('[AssetDataTable] Failed to open scope folder:', err);
    }
  }, [computeNode?.typeId, folderPathForRow]);

  // Build a project_id → display-name lookup so the scope column can render
  // human-readable project names instead of the project_id UUID. The API today
  // returns `project_name: null` on rows, so we resolve here client-side via
  // the same project list that powers `ProjectPickerModal`. New rows may carry
  // Project.id; older rows may carry record_project_id.
  const { projects } = useProjectList();
  const projectNameById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) {
      const label = getProjectDisplayName(p);
      if (p.id) m.set(p.id, label);
      const recordPid = p.record_project_id || recordProjectIdForPath(p.cwd || p.name);
      if (recordPid) m.set(recordPid, label);
    }
    return m;
  }, [projects]);

  const renderScope = React.useCallback(
    (r: SearchResult): React.ReactNode => {
      if (r.scope !== 'user' && r.scope !== 'project') return '—';
      const folder = folderPathForRow(r);
      const canOpen = !!computeNode?.typeId && !!folder;
      const handleClick = (e: React.MouseEvent) => {
        if (!canOpen) return;
        e.stopPropagation();
        void openScopeFolder(r);
      };
      const tag = scopeTag(r.scope);
      const projectLabel = r.scope === 'project'
        ? ((r.project_name || (r.project_id ? projectNameById.get(r.project_id) : undefined)) ?? r.project_id ?? '')
        : '';
      return React.createElement(
        'span',
        {
          onClick: handleClick,
          title: canOpen ? `Open ${folder} in OS file manager` : undefined,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            cursor: canOpen ? 'pointer' : 'default',
          },
        },
        tag,
        projectLabel ? React.createElement('span', { style: { fontSize: '12px', color: '#64748b' } }, projectLabel) : null,
      );
    },
    [projectNameById, folderPathForRow, computeNode?.typeId, openScopeFolder],
  );

  const baseColumns: ColumnDef[] = [
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
