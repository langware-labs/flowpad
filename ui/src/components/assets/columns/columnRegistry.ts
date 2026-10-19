import { ReactNode } from 'react';
import type { SearchRow } from '@src/hooks/search-row';

export interface ColumnActions {
  filterByProject?: (label: string) => void;
}

export interface ColumnDef {
  key: string;
  header: string;
  render: (row: SearchRow, actions?: ColumnActions) => ReactNode;
  width?: number;
}

const registry = new Map<string, ColumnDef[]>();

export function registerColumns(type: string, cols: ColumnDef[]) {
  registry.set(type, cols);
}

export function getColumns(type: string): ColumnDef[] {
  return registry.get(type) ?? [];
}
