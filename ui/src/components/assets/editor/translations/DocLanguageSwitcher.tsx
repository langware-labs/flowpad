import { t } from '@lingui/core/macro';
import { useMemo, useState } from 'react';
import { Check, Languages, Loader2 } from 'lucide-react';
import { cn } from '@src/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@src/components/ui/command';
import type { TranslationTarget } from '@sdk/models';
import type { TranslationView } from './useTranslations';
import { LangLabel, availableTargets, targetLabel } from './translation-ui';

interface DocLanguageSwitcherProps {
  /** Existing translations with live status. */
  translations: TranslationView[];
  /** Active `?lang=` (null = original doc). */
  activeLang: string | null;
  /** Whether a launch is in flight. */
  isAdding: boolean;
  /** Full target-language catalog (from bootstrap). */
  targets: TranslationTarget[];
  /** Switch to a translation, or back to the original with null. */
  onOpen: (lang: string | null) => void;
  /** Create + launch a translation for the given language. */
  onAdd: (lang: string) => void;
  className?: string;
}

/**
 * Generic, reusable inline language switcher for a translatable doc. Purely
 * presentational — fed by `useTranslations` data (the single source of
 * translation logic), so any doc surface can drop it into a header without
 * re-implementing anything. Shows the current language and a searchable popover
 * that both SWITCHES to an existing translation and ADDS a new one.
 */
export function DocLanguageSwitcher({
  translations,
  activeLang,
  isAdding,
  targets,
  onOpen,
  onAdd,
  className,
}: DocLanguageSwitcherProps) {
  const [open, setOpen] = useState(false);

  const available = useMemo(() => availableTargets(translations, targets), [translations, targets]);
  const currentLabel = activeLang ? targetLabel(activeLang, targets).native : 'Original';

  const switchTo = (lang: string | null) => {
    setOpen(false);
    onOpen(lang);
  };
  const add = (lang: string) => {
    setOpen(false);
    onAdd(lang);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t`Translations`}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            className,
          )}
        >
          {isAdding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Languages className="h-3.5 w-3.5" />}
          <span className="max-w-[10rem] truncate">{currentLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={t`Search languages…`} />
          <CommandList>
            <CommandEmpty>No languages found.</CommandEmpty>
            <CommandGroup heading={t`This document`}>
              <CommandItem
                value="original Original"
                onSelect={() => switchTo(null)}
                className="cursor-pointer gap-2"
              >
                <span className="flex-1">Original</span>
                {activeLang === null && <Check className="h-4 w-4" />}
              </CommandItem>
              {translations.map((tr) => {
                const { native, english } = targetLabel(tr.lang, targets);
                const active = tr.lang === activeLang;
                return (
                  <CommandItem
                    key={tr.lang}
                    value={`${native} ${english} ${tr.lang}`}
                    onSelect={() => switchTo(tr.lang)}
                    className="cursor-pointer gap-2"
                  >
                    <span className="flex-1">
                      <LangLabel native={native} english={english} />
                    </span>
                    {tr.status === 'translating' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    ) : (
                      active && <Check className="h-4 w-4" />
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {available.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading={t`Translate to`}>
                  {available.map((target) => (
                    <CommandItem
                      key={target.code}
                      value={`add ${target.nativeName} ${target.englishName} ${target.code}`}
                      onSelect={() => add(target.code)}
                      className="cursor-pointer gap-2"
                    >
                      <LangLabel native={target.nativeName} english={target.englishName} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
