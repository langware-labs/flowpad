import React from 'react';
import { FilePlus, Search } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useAssetSearch } from '@src/hooks/use-asset-search';
import type { SearchResult } from '@src/hooks/use-asset-search';
import { AssetDataTable } from './AssetDataTable';
import { QuickFilterBar } from './QuickFilterBar';
import { TagFilterBar } from './TagFilterBar';
import type { FilterState } from './filters/filterRegistry';
import type { AssetFilter } from './assetFilter';

interface Props {
  recordType: string;
  onNew?: () => void;
  refreshKey?: number;
  onRowClick?: (result: SearchResult) => void;
  filter: AssetFilter;
  onFilterChange: (f: AssetFilter) => void;
  onProjectFilter?: (label: string) => void;
}

export function AssetListView({ recordType, onNew, refreshKey, onRowClick, filter, onFilterChange, onProjectFilter }: Props) {
  const { t } = useLingui();
  const { results, total, isLoading, page, pageSize, setPage } = useAssetSearch({
    recordType,
    filter,
    page: 1,
    pageSize: 20,
    refreshKey,
  });

  const handleQueryChange = (q: string) => {
    onFilterChange({ ...filter, query: q });
    setPage(1);
  };

  const handleFiltersChange = (f: FilterState) => {
    onFilterChange({ ...filter, filters: f });
    setPage(1);
  };

  const handleTagsChange = (t: string[]) => {
    onFilterChange({ ...filter, tags: t });
    setPage(1);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Search + filters bar */}
      <div className="flex flex-shrink-0 flex-col gap-2 border-b p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={filter.query}
              onChange={(e) => handleQueryChange(e.target.value)}
              placeholder={t`Search…`}
              className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
            />
          </div>
          {onNew && (
            <button
              onClick={() => onNew()}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground hover:text-foreground"
              title={t`New`}
            >
              <FilePlus className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <QuickFilterBar recordType={recordType} filters={filter.filters} onChange={handleFiltersChange} />
          <TagFilterBar tags={filter.tags} onTagsChange={handleTagsChange} />
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto p-3">
        {isLoading ? (
          <div className="flex h-20 items-center justify-center text-sm text-muted-foreground">
            <Trans>Loading…</Trans>
          </div>
        ) : (
          <AssetDataTable
            results={results}
            total={total}
            page={page}
            pageSize={pageSize}
            onPageChange={setPage}
            recordType={recordType}
            onRowClick={onRowClick}
            onProjectFilter={onProjectFilter}
          />
        )}
      </div>
    </div>
  );
}
