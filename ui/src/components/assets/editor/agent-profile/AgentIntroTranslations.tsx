import { useLingui } from '@lingui/react/macro';
import { Plus, X } from 'lucide-react';

import { Button } from '@src/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { Textarea } from '@src/components/ui/textarea';
import { useSupportedLocales } from '@src/contexts/locale-context';

/** The "+" beside the Intro label: adds an empty translation for a language not yet added. */
export function AddIntroTranslationButton({
  translations,
  onAdd,
}: {
  translations: Record<string, string>;
  onAdd: (code: string) => void;
}) {
  const { t } = useLingui();
  const missing = useSupportedLocales().filter((l) => !(l.code in translations));
  if (missing.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          aria-label={t`Add intro in another language`}
          title={t`Add intro in another language`}
          data-testid="agent-intro-add-language"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {missing.map((l) => (
          <DropdownMenuItem key={l.code} onSelect={() => onAdd(l.code)} data-testid={`agent-intro-add-${l.code}`}>
            {l.nativeName}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One Textarea per added language; the active locale's entry replaces `intro` in the chat. */
export function IntroTranslationFields({
  translations,
  onChange,
  onCommit,
}: {
  translations: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  onCommit: (next: Record<string, string>) => void;
}) {
  const { t } = useLingui();
  const locales = useSupportedLocales();
  const codes = Object.keys(translations);
  if (codes.length === 0) return null;
  const nameOf = (code: string) => locales.find((l) => l.code === code)?.nativeName ?? code;
  const dirOf = (code: string) => locales.find((l) => l.code === code)?.dir;
  const without = (code: string) => Object.fromEntries(Object.entries(translations).filter(([c]) => c !== code));
  return (
    <div className="mt-2 flex flex-col gap-2">
      {codes.map((code) => (
        <div key={code} data-testid={`agent-intro-translation-${code}`}>
          <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
            <span>{nameOf(code)}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-4 w-4"
              aria-label={t`Remove ${nameOf(code)}`}
              onClick={() => onCommit(without(code))}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
          <Textarea
            value={translations[code]}
            dir={dirOf(code)}
            onChange={(e) => onChange({ ...translations, [code]: e.target.value })}
            onBlur={() => onCommit({ ...translations, [code]: translations[code].trim() })}
            aria-label={t`Intro in ${nameOf(code)}`}
            className="min-h-16 resize-none text-sm"
            rows={2}
          />
        </div>
      ))}
    </div>
  );
}
