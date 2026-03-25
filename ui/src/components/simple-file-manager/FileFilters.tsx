import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@src/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { Filter } from 'lucide-react';
import { FilterDefinition, FilterName } from './filters';

export interface FileFiltersProps {
  /** Available filter definitions */
  filters: FilterDefinition[];
  /** Currently enabled filter names */
  enabledFilters: FilterName[];
  /** Callback when filters change - emits array of enabled filter names */
  onFiltersChange: (enabledFilters: FilterName[]) => void;
}

export function FileFilters({ filters, enabledFilters, onFiltersChange }: FileFiltersProps) {
  const handleToggleFilter = (filterName: FilterName) => {
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
            <Button data-testid="file-filters-button" variant="ghost" size="icon" className="h-7 w-7">
              <Filter className="h-4 w-4" />
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
