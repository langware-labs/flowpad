import { useMemo, useState } from 'react';
import { Check, FileText, Loader2, Plus } from 'lucide-react';
import { cn } from '@src/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@src/components/ui/command';
import type { TranslationTarget } from '@sdk/models';
import type { TranslationView } from './useTranslations';
import { LangLabel, availableTargets, targetLabel } from './translation-ui';

interface TranslationsPanelProps {
  /** Existing translations with live status. */
  translations: TranslationView[];
  /** Active `?lang=` (null = original doc). */
  activeLang: string | null;
  /** Whether a launch is in flight. */
  isAdding: boolean;
  /** Full target-language catalog (from bootstrap). */
  targets: TranslationTarget[];
  /** Navigate to a translation, or back to the original with null. */
  onOpen: (lang: string | null) => void;
  /** Create + launch a translation for the given language. */
  onAdd: (lang: string) => void;
}

/**
 * The Translations side panel. Lists the original doc + each translated copy;
 * the active row (URL-first, from `?lang=`) is highlighted, and per-row status
 * shows a spinner while its translator worker runs. "Add translation" opens a
 * searchable language picker (mirrors the footer `LanguageSelector`); picking a
 * language that isn't translated yet launches the translator wizard.
 */
export function TranslationsPanel({
  translations,
  activeLang,
  isAdding,
  targets,
  onOpen,
  onAdd,
}: TranslationsPanelProps) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const available = useMemo(() => availableTargets(translations, targets), [translations, targets]);

  const handlePick = (code: string) => {
    setPickerOpen(false);
    onAdd(code);
  };

  return (
    <div className="flex h-full flex-col gap-1 p-2 text-sm">
      {/* Original doc */}
      <button
        type="button"
        onClick={() => onOpen(null)}
        className={cn(
          'flex items-center gap-2 rounded-md px-2 py-1.5 text-start transition-colors hover:bg-accent',
          activeLang === null && 'bg-accent font-medium',
        )}
      >
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1">Original</span>
        {activeLang === null && <Check className="h-4 w-4" />}
      </button>

      {/* Translations */}
      {translations.map((tr) => {
        const { native, english } = targetLabel(tr.lang, targets);
        const active = tr.lang === activeLang;
        return (
          <button
            key={tr.lang}
            type="button"
            onClick={() => onOpen(tr.lang)}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-start transition-colors hover:bg-accent',
              active && 'bg-accent font-medium',
            )}
          >
            <span className="flex-1">
              <LangLabel native={native} english={english} />
            </span>
            {tr.status === 'translating' ? (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Translating…
              </span>
            ) : (
              active && <Check className="h-4 w-4" />
            )}
          </button>
        );
      })}

      {/* Add translation */}
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={isAdding || available.length === 0}
            className="mt-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-start text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            <span>Add translation</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          <Command>
            <CommandInput placeholder="Search languages…" />
            <CommandList>
              <CommandEmpty>No languages found.</CommandEmpty>
              <CommandGroup heading="Translate to">
                {available.map((target) => (
                  <CommandItem
                    key={target.code}
                    value={`${target.nativeName} ${target.englishName} ${target.code}`}
                    onSelect={() => handlePick(target.code)}
                    className="cursor-pointer gap-2"
                  >
                    <LangLabel native={target.nativeName} english={target.englishName} />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
