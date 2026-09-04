import React, { useCallback, useState } from 'react';
import { Check, ChevronsUpDown, Loader2, X } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { DataSource, FieldType, type DataSourceChoice, type SpecConfigField } from '@sdk';
import { cn } from '@src/lib/utils';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@src/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { failedFetch, fallsBackToTyping, mergeChoices, nextFetch, type ChoiceFetch } from './choice-fetch';

/**
 * A config field whose values the provider can list.
 *
 * Three of the twelve providers ask for an id nobody can produce from memory — a shared
 * drive is `0AB1cdEfGhIjKlMnOpQ`. This is the fix for that, and nothing more: ONE flat
 * list, never a tree.
 *
 * **It never becomes a dead end.** Listing needs a live credential and a scope, and a
 * project id GCS cannot infer, so "cannot list" is an ordinary outcome rather than a rare
 * one. When it happens the field falls back to the plain input the form has always had,
 * with the reason beside it — and the caller renders that, so the picker and the input can
 * never both be on screen.
 *
 * **The fetch fires on open, not on mount.** Most edits never touch this field, and each
 * open is a live call out to Google or Slack.
 */
export function ChoiceField({
  fieldKey,
  field,
  provider,
  config,
  picked,
  onPicked,
  fallback,
}: {
  fieldKey: string;
  field: SpecConfigField;
  provider: string;
  /** The draft config so far — GCS cannot list buckets without its `project`. */
  config: Record<string, unknown>;
  picked: DataSourceChoice[];
  onPicked: (choices: DataSourceChoice[]) => void;
  /** The ordinary input this field would have had. Rendered INSTEAD of the picker when
   *  the provider cannot list — passed in rather than decided by the caller so the two
   *  can never both appear. */
  fallback: React.ReactNode;
}) {
  const [fetch, setFetch] = useState<ChoiceFetch>({ status: 'unfetched' });
  const [open, setOpen] = useState(false);
  const many = field.type === FieldType.LINES;

  const load = useCallback(async () => {
    setFetch({ status: 'loading' });
    try {
      setFetch(nextFetch(await DataSource.choices(provider, fieldKey, config)));
    } catch (error) {
      setFetch(failedFetch(error));
    }
  }, [provider, fieldKey, config]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    // Re-listed on every open, deliberately: a channel created a minute ago should be
    // there, and the answer depends on a draft `project` the user may just have typed.
    if (next) void load();
  };

  const toggle = (choice: DataSourceChoice) => {
    if (!many) {
      onPicked([choice]);
      setOpen(false);
      return;
    }
    const already = picked.some((c) => c.id === choice.id);
    onPicked(already ? picked.filter((c) => c.id !== choice.id) : [...picked, choice]);
  };

  const offered = fetch.status === 'ready' ? mergeChoices(picked, fetch.choices) : picked;
  const label = picked.length === 1 ? picked[0].name : '';

  // Asked, and the answer was no. Hand the field back to typing for the rest of this
  // dialog — re-offering a picker that just refused would only invite the same click.
  if (fallsBackToTyping(fetch)) {
    return (
      <div className="space-y-1">
        {fallback}
        <p className="text-xs text-amber-600 dark:text-amber-500" data-testid={`ds-choice-detail-${fieldKey}`}>
          {fetch.detail}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal"
            data-testid={`ds-choice-${fieldKey}`}
          >
            <span className={cn('truncate', !picked.length && 'text-muted-foreground')}>
              {picked.length === 0 ? (
                field.placeholder || <Trans>Choose…</Trans>
              ) : many && picked.length > 1 ? (
                <Trans>{picked.length} selected</Trans>
              ) : (
                label
              )}
            </span>
            {fetch.status === 'loading' ? (
              <Loader2 className="ms-2 h-4 w-4 shrink-0 animate-spin opacity-50" />
            ) : (
              <ChevronsUpDown className="ms-2 h-4 w-4 shrink-0 opacity-50" />
            )}
          </Button>
        </PopoverTrigger>

        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command>
            <CommandInput placeholder={field.label || fieldKey} />
            <CommandList>
              <CommandEmpty>
                {fetch.status === 'loading' ? <Trans>Loading…</Trans> : <Trans>Nothing found.</Trans>}
              </CommandEmpty>
              {offered.map((choice) => (
                <CommandItem
                  key={choice.id}
                  value={`${choice.name} ${choice.id}`}
                  onSelect={() => toggle(choice)}
                  data-testid={`ds-choice-${fieldKey}-${choice.id}`}
                >
                  <Check
                    className={cn(
                      'me-2 h-4 w-4',
                      picked.some((c) => c.id === choice.id) ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  <span className="truncate">{choice.name}</span>
                  {choice.detail && (
                    <span className="ms-auto ps-2 text-xs text-muted-foreground">{choice.detail}</span>
                  )}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {/* The picks, so a multi-select shows WHAT is chosen without opening the list. */}
      {many && picked.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {picked.map((choice) => (
            <Badge key={choice.id} variant="secondary" className="gap-1 font-normal">
              {choice.name}
              <button
                type="button"
                aria-label={`Remove ${choice.name}`}
                onClick={() => onPicked(picked.filter((c) => c.id !== choice.id))}
                className="opacity-60 hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
