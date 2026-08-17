import { Check } from 'lucide-react';
import { useMemo } from 'react';
import { cn } from '@src/lib/utils';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@src/components/ui/command';
import { getRecentLocales, useLocale, useSupportedLocales, type LocaleInfo } from '@src/contexts/locale-context';

/**
 * The shared language-picker body: a searchable list with the active +
 * recently-used locales pinned on top and every shipped locale below. Used by
 * the footer chip (`LanguageSelector`) and by the project's Language card, so
 * both offer the same list and the same search behaviour.
 *
 * Selection is the caller's business — this component never writes locale state.
 */

/** SVG flag via flag-icons (CSS imported once in styles/index.css). */
export function Flag({ code, className }: { code: string; className?: string }) {
  return <span className={cn('fi', `fi-${code}`, className)} aria-hidden="true" />;
}

function LocaleRow({
  info,
  active,
  onSelect,
}: {
  info: LocaleInfo;
  active: boolean;
  onSelect: (code: string) => void;
}) {
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
 * @param selectedCode which row shows the check mark — the app locale in the
 *   footer, the project's stored locale in the project card.
 */
export function LocalePicker({
  selectedCode,
  onSelect,
}: {
  selectedCode: string | null;
  onSelect: (code: string) => void;
}) {
  const { t } = useLingui();
  const activeCode = useLocale();
  const supportedLocales = useSupportedLocales();

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

  return (
    <Command>
      <CommandInput placeholder={t`Search languages…`} />
      <CommandList>
        <CommandEmpty>
          <Trans>No languages found.</Trans>
        </CommandEmpty>
        <CommandGroup heading={t`Active`}>
          {pinned.map((info) => (
            <LocaleRow key={info.code} info={info} active={info.code === selectedCode} onSelect={onSelect} />
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t`All languages`}>
          {supportedLocales.map((info) => (
            <LocaleRow key={info.code} info={info} active={info.code === selectedCode} onSelect={onSelect} />
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
