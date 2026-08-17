import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Flag, LocalePicker } from '@src/components/locale/LocalePicker';
import { setLocale, useLocale, useLocaleInfo, useSupportedLocales } from '@src/contexts/locale-context';

/**
 * Footer language picker. Button shows the active locale's flag + code; clicking
 * opens the shared searchable list (`LocalePicker`). Selecting calls `setLocale`
 * — the locale context is the single writer of `<html dir/lang>`, the active
 * Lingui catalog, and the current project's remembered language, so nothing else
 * is mutated here.
 */
export function LanguageSelector() {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const activeCode = useLocale();
  const activeInfo = useLocaleInfo();
  const supportedLocales = useSupportedLocales();

  const handleSelect = (code: string) => {
    void setLocale(code);
    setOpen(false);
  };

  // Only offer the picker when the backend ships 2+ locales (a genuine choice).
  // Deliberately NOT gated on `navigator.languages`: that reports the OS
  // preferred-languages list, which says nothing about what a user reads or
  // types — a Hebrew typist on an English UI reports only `en`, and gating on it
  // hid the picker from exactly the people who wanted it. The OS signal still
  // picks the first-run default (locale-context's `resolveInitialLocale`).
  if (supportedLocales.length < 2) return null;

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
        <LocalePicker selectedCode={activeCode} onSelect={handleSelect} />
      </PopoverContent>
    </Popover>
  );
}
