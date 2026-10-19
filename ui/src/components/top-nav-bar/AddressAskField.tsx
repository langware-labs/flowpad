import { useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Sparkles, X } from 'lucide-react';
import { ADDRESS_PILL_CLASS } from './address-pill';

/**
 * The address bar in ask mode — a click on the pill's dead space turns it into
 * a prompt for the Flowpad Assistant: "What do you want to do?".
 *
 * Enter hands the text to `onAsk` (the assistant's `ask`, which opens the
 * CURRENT page's chat and sends it as if typed there) and gives the address
 * back. Escape, the ✕, or a click outside abandon it — the same exits search
 * mode has, so the two modes of the slot behave alike.
 */
export function AddressAskField({
  onAsk,
  onClose,
}: {
  onAsk: (text: string, rect: DOMRect | null) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && fieldRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('pointerdown', closeOutside, true);
    return () => window.removeEventListener('pointerdown', closeOutside, true);
  }, [onClose]);

  const submit = () => {
    const request = text.trim();
    if (!request) return;
    onAsk(request, fieldRef.current?.getBoundingClientRect() ?? null);
    onClose();
  };

  return (
    <div
      ref={fieldRef}
      data-testid="top-nav-ask"
      className={`${ADDRESS_PILL_CLASS} border-primary ring-1 ring-primary/30`}
    >
      <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={t`What do you want to do?`}
        aria-label={t`Ask the Flowpad Assistant`}
        data-testid="top-nav-ask-input"
        className="h-full min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
      />
      <button
        type="button"
        onClick={onClose}
        aria-label={t`Close`}
        data-testid="top-nav-ask-close"
        className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
