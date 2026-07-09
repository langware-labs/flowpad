import { Check } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '@src/lib/utils';
import { Trans, useLingui } from '@lingui/react/macro';
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
import {
  useSupportedLocales,
  useShowLocaleChip,
  getRecentLocales,
  setLocale,
  useLocale,
  useLocaleInfo,
  type LocaleInfo,
} from '@src/contexts/locale-context';

/** SVG flag via flag-icons (CSS imported once in styles/index.css). */
function Flag({ code, className }: { code: string; className?: string }) {
  return <span className={cn('fi', `fi-${code}`, className)} aria-hidden="true" />;
}

function LocaleRow({ info, active, onSelect }: { info: LocaleInfo; active: boolean; onSelect: (code: string) => void }) {
  return (
    <CommandItem
      // Include all searchable text in the value so cmdk's built-in filter
      // matches on native name, English name, and code.
      value={`${info.nativeName} ${info.englishName} ${info.code}`}
      onSelect={() => onSelect(info.code)}
      className="cursor-pointer gap-2"
    >
      <Flag code={info.flag} className="text-base" />
      <span className="flex flex-col">
        <span className="leading-tight">{info.nativeName}</span>
        {info.nativeName !== info.englishName && (
          <span className="text-xs text-muted-foreground">{info.englishName}</span>
        )}
      </span>
      <Check className={cn('ms-auto h-4 w-4', active ? 'opacity-100' : 'opacity-0')} />
    </CommandItem>
  );
}

/**
 * Footer language picker. Button shows the active locale's flag + code; clicking
 * opens a searchable list. A dedicated top section pins the active +
 * recently-used locales; below it, all shipped locales. Selecting calls
 * `setLocale` — the locale context is the single writer of `<html dir/lang>` and
 * the active Lingui catalog, so nothing else is mutated here.
 */
export function LanguageSelector() {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const activeCode = useLocale();
  const activeInfo = useLocaleInfo();
  const supportedLocales = useSupportedLocales();
  const showLocaleChip = useShowLocaleChip();

  // Active + recents, de-duped, in the dedicated top section. `activeCode`
  // updates on every selection (incl. ones made elsewhere, via the locale
  // listener); `supportedLocales` updates when the backend list arrives.
  const pinned = useMemo(
    () =>
      [...new Set([activeCode, ...getRecentLocales()])]
        .map((c) => supportedLocales.find((l) => l.code === c))
        .filter((l): l is LocaleInfo => !!l),
    [activeCode, supportedLocales],
  );

  const handleSelect = (code: string) => {
    void setLocale(code);
    setOpen(false);
  };

  // Only offer the picker when the OS reports 2+ languages we support (a genuine
  // choice). With 0 or 1, the locale is auto-selected and the chip is hidden — so
  // a machine with no Arabic never sees an Arabic option.
  if (!showLocaleChip) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={t`Change language`}
          aria-label={t`Change language`}
        >
          <Flag code={activeInfo.flag} className="text-sm" />
          <span className="uppercase">{activeInfo.code.split('-')[0]}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={t`Search languages…`} />
          <CommandList>
            <CommandEmpty><Trans>No languages found.</Trans></CommandEmpty>
            <CommandGroup heading={t`Active`}>
              {pinned.map((info) => (
                <LocaleRow key={info.code} info={info} active={info.code === activeCode} onSelect={handleSelect} />
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading={t`All languages`}>
              {supportedLocales.map((info) => (
                <LocaleRow key={info.code} info={info} active={info.code === activeCode} onSelect={handleSelect} />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
