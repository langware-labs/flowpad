import React from 'react';
import { registerFilters, FilterState } from './filterRegistry';

const AssetFilters: React.FC<{ filters: FilterState; onChange: (f: FilterState) => void }> = () => null;

registerFilters('asset', AssetFilters);
export {};
