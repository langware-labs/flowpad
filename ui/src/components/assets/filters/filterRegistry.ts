import React from 'react';

export interface FilterState {
  [key: string]: string;
}

export type FilterComponent = React.FC<{ filters: FilterState; onChange: (f: FilterState) => void }>;

const registry = new Map<string, FilterComponent>();

export function registerFilters(type: string, comp: FilterComponent) {
  registry.set(type, comp);
}

export function getFilters(type: string): FilterComponent | undefined {
  return registry.get(type);
}
