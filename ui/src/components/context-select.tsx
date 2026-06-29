import { ontologyStore } from '@sdk';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from 'cmdk';
import { Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { LabelChipBlock } from './label-chip-block';

interface ContextSelectProps {
  selectedLabels: string[];
  onSelect: (label: string) => void;
  onRemove: (label: string) => void;
  onAdd: (label: string) => void;
  placeholder?: string;
}

export function ContextSelect({
  selectedLabels,
  onSelect,
  onRemove,
  onAdd,
  placeholder,
}: ContextSelectProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const resolvedPlaceholder = placeholder ?? t`Search labels...`;

  // Get all ontologies and their labels
  const ontologyNames = ontologyStore.getOntologyNames();
  const ontologies = ontologyNames
    .map((name) => ({
      name,
      ontology: ontologyStore.getOntology(name)!,
    }))
    .filter((o) => o.ontology);

  // Handle selection
  const handleSelect = (labelId: string) => {
    console.log('ContextSelect handleSelect called with:', labelId);
    onSelect(labelId);
    setSearch('');
    setOpen(false);
  };

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };

    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  return (
    <div className="flex flex-col gap-2">
      {/* Label chips with expand/collapse functionality */}
      <LabelChipBlock
        labels={selectedLabels}
        selected={selectedLabels}
        maxChips={3}
        onToggle={onSelect}
        onRemove={onRemove}
      />

      {/* cmdk search interface */}
      <div className="relative" ref={containerRef}>
        <Command
          className="overflow-visible rounded-lg border bg-background"
          shouldFilter={true}
          loop
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
        >
          <CommandInput
            value={search}
            onValueChange={(value) => {
              setSearch(value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && search.trim()) {
                // Check if there are any matching results
                const hasResults = ontologies.some(({ ontology }) => {
                  const labels = ontology.getAllLabels();
                  return labels.some((labelInfo) => labelInfo.display.toLowerCase().includes(search.toLowerCase()));
                });

                // If no results found, add as custom label
                if (!hasResults) {
                  e.preventDefault();
                  e.stopPropagation();
                  onAdd(search.trim());
                  setSearch('');
                  setOpen(false);
                }
                // Otherwise, let cmdk handle Enter to select highlighted item
              }
            }}
            placeholder={resolvedPlaceholder}
            className="w-full border-none bg-transparent px-2 py-1 text-xs outline-none placeholder:text-muted-foreground"
          />

          <CommandList
            className={`absolute top-full z-50 mt-1 max-h-[300px] w-[300px] overflow-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md ${
              open ? 'block animate-in fade-in-0 zoom-in-95' : 'hidden'
            }`}
          >
            <CommandEmpty className="py-6 text-center text-sm text-muted-foreground"><Trans>No labels found.</Trans></CommandEmpty>

            {ontologies.map(({ name, ontology }) => {
              const labels = ontology.getAllLabels();
              if (labels.length === 0) return null;

              return (
                <CommandGroup
                  key={name}
                  heading={name}
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:capitalize [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                  {labels.map((labelInfo) => {
                    // Construct full label ID: "--ontology--.path"
                    // labelInfo.label contains just the path (e.g., "solution_engineer")
                    const fullLabel = `${ontology.labelPrefix}.${labelInfo.label}`;
                    const isSelected = selectedLabels.includes(fullLabel);

                    return (
                      <CommandItem
                        key={fullLabel}
                        value={fullLabel}
                        onSelect={() => handleSelect(fullLabel)}
                        onPointerDown={(e) => {
                          e.preventDefault();
                          handleSelect(fullLabel);
                        }}
                        className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none aria-selected:bg-accent aria-selected:text-accent-foreground"
                      >
                        <Check
                          className={`pointer-events-none mr-2 h-4 w-4 ${isSelected ? 'opacity-100' : 'opacity-0'}`}
                        />
                        <div className="pointer-events-none flex flex-col">
                          <span>{labelInfo.display}</span>
                          {labelInfo.description && (
                            <span className="text-xs text-muted-foreground">{labelInfo.description}</span>
                          )}
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </div>
    </div>
  );
}
