import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@src/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { Filter } from 'lucide-react';
import type { FilterDefinition } from './types';

export interface FilterDropdownProps {
  /** Available filter definitions */
  filters: FilterDefinition[];
  /** Currently enabled filter names */
  enabledFilters: string[];
  /** Callback when filters change - emits array of enabled filter names */
  onFiltersChange: (enabledFilters: string[]) => void;
}

/**
 * FilterDropdown - Unified filter UI component for DirectoryTree
 *
 * Displays a single filter button that opens a dropdown with checkboxes
 * for each available filter. Consolidates filter UX across all directory trees.
 */
export function FilterDropdown({ filters, enabledFilters, onFiltersChange }: FilterDropdownProps) {
  const handleToggleFilter = (filterName: string) => {
    const isCurrentlyEnabled = enabledFilters.includes(filterName);
    const newEnabledFilters = isCurrentlyEnabled
      ? enabledFilters.filter((name) => name !== filterName)
      : [...enabledFilters, filterName];
    onFiltersChange(newEnabledFilters);
  };

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              data-testid="directory-tree-filters-button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title="Filters"
            >
              <Filter className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Filters</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-48">
        {filters.map((filter) => (
          <DropdownMenuItem
            key={filter.name}
            className="flex items-center gap-2"
            onSelect={(e) => {
              e.preventDefault();
              handleToggleFilter(filter.name);
            }}
          >
            <Checkbox checked={enabledFilters.includes(filter.name)} />
            <span className="flex-1">{filter.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
