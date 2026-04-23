import { ReactNode } from 'react';

export interface SearchResult {
  record_id: string;
  record_type: string;
  name: string;
  snippet: string | null;
  status: string;
  scope: string;
  asset_ref: string;
  created_at: string;
  modified_at: string;
  uname?: string;
  title?: string;
  description?: string;
  file_path?: string;
  filename?: string;
  work_dir?: string;
  project_encoded?: string;
  asset_type?: string;
}

export interface ColumnActions {
  filterByProject?: (label: string) => void;
}

export interface ColumnDef {
  key: string;
  header: string;
  render: (row: SearchResult, actions?: ColumnActions) => ReactNode;
  width?: number;
}

const registry = new Map<string, ColumnDef[]>();

export function registerColumns(type: string, cols: ColumnDef[]) {
  registry.set(type, cols);
}

export function getColumns(type: string): ColumnDef[] {
  return registry.get(type) ?? [];
}
