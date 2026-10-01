import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Flag, LocalePicker } from '@src/components/locale/LocalePicker';
import { setLocale, useLocale, useLocaleInfo, useQuickLocaleSwitch } from '@src/contexts/locale-context';

/**
 * Footer quick language switch. Button shows the active locale's flag + code; clicking
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
  const showQuickSwitch = useQuickLocaleSwitch();

  const handleSelect = (code: string) => {
    void setLocale(code);
    setOpen(false);
  };

  // A QUICK switch, so only where the user has a second language to switch to:
  // the user's languages (navigator + OS display languages + keyboard layouts —
  // the layouts are what catch a Hebrew typist on an English OS) must share 2+
  // with the app's. Every language stays reachable from Settings → Language.
  if (!showQuickSwitch) return null;

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
