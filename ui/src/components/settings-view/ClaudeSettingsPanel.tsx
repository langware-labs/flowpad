import { useState, useMemo, useEffect, useRef } from 'react';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react/macro';
import { Search } from 'lucide-react';
import { Input } from '@src/components/ui/input';
import { Checkbox } from '@src/components/ui/checkbox';
import { Label } from '@src/components/ui/label';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@src/components/ui/accordion';
import type { ClaudeSettingsJsonRecordList } from '@sdk';
import { flattenSettings, matchesSearch, groupByCategory, CATEGORY_ORDER, categoryLabel } from './settings-utils';
import { SettingsFieldRow } from './SettingsFieldRow';

interface ClaudeSettingsPanelProps {
  userRecords: ClaudeSettingsJsonRecordList | null;
  projectRecords: ClaudeSettingsJsonRecordList | null;
  localRecords: ClaudeSettingsJsonRecordList | null;
  /** Initial search filter from URL ?filter= */
  initialFilter?: string;
  /** Initial field name from URL pointer (settings/<field_name>) */
  initialFieldName?: string;
}

export function ClaudeSettingsPanel({
  userRecords,
  projectRecords,
  localRecords,
  initialFilter = '',
  initialFieldName = '',
}: ClaudeSettingsPanelProps) {
  const { t } = useLingui();
  const [searchQuery, setSearchQuery] = useState(initialFilter || initialFieldName);
  const [showOverrides, setShowOverrides] = useState(false);
  const highlightedFieldRef = useRef<HTMLDivElement>(null);

  const allFields = useMemo(
    () => flattenSettings(userRecords, projectRecords, localRecords),
    [userRecords, projectRecords, localRecords],
  );

  const filteredFields = useMemo(() => {
    if (!searchQuery.trim()) return allFields;
    return allFields.filter((f) => matchesSearch(f, searchQuery));
  }, [allFields, searchQuery]);

  const isSearching = searchQuery.trim().length > 0;
  const groups = useMemo(() => groupByCategory(filteredFields), [filteredFields]);

  // Scroll to highlighted field on initial load
  useEffect(() => {
    if (initialFieldName && highlightedFieldRef.current) {
      highlightedFieldRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [initialFieldName]);

  return (
    <div className="space-y-4">
      {/* Search bar + override toggle */}
      <div className="flex items-center gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t`Search settings...`}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="ps-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="show-overrides"
            checked={showOverrides}
            onCheckedChange={(checked) => setShowOverrides(checked === true)}
          />
          <Label htmlFor="show-overrides" className="cursor-pointer whitespace-nowrap text-sm">
            <Trans>Show scope overrides</Trans>
          </Label>
        </div>
      </div>

      {/* Settings list */}
      {filteredFields.length === 0 ? (
        <div className="rounded-lg border p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {isSearching ? <Trans>No settings match your search.</Trans> : <Trans>No settings loaded.</Trans>}
          </p>
        </div>
      ) : isSearching ? (
        /* Flat list when searching */
        <div className="divide-y rounded-lg border">
          {filteredFields.map((field) => (
            <div
              key={field.key}
              className="px-4"
              ref={field.key === initialFieldName ? highlightedFieldRef : undefined}
            >
              <SettingsFieldRow
                field={field}
                showOverrides={showOverrides}
                highlighted={field.key === initialFieldName}
              />
            </div>
          ))}
        </div>
      ) : (
        /* Accordion by category when not searching */
        <Accordion type="multiple" defaultValue={CATEGORY_ORDER}>
          {Array.from(groups.entries()).map(([category, fields]) => (
            <AccordionItem key={category} value={category}>
              <AccordionTrigger className="text-sm font-semibold">
                {categoryLabel(category)}
                <span className="ms-2 text-xs font-normal text-muted-foreground">({fields.length})</span>
              </AccordionTrigger>
              <AccordionContent>
                <div className="divide-y">
                  {fields.map((field) => (
                    <div key={field.key} ref={field.key === initialFieldName ? highlightedFieldRef : undefined}>
                      <SettingsFieldRow
                        field={field}
                        showOverrides={showOverrides}
                        highlighted={field.key === initialFieldName}
                      />
                    </div>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}
    </div>
  );
}
