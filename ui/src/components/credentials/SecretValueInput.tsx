import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { Input } from '@src/components/ui/input';
import { cn } from '@src/lib/utils';

export interface SecretValueInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  value: string;
  onValueChange: (value: string) => void;
  /** Masked with a reveal toggle when true; a plain text box otherwise. */
  secret?: boolean;
}

/**
 * The one input a secret value is typed into.
 *
 * `autoComplete="new-password"` keeps a browser from offering the user's saved
 * site password. A password manager can still fill the box natively without an
 * event React hears, so the value is re-read from the element on blur.
 */
export const SecretValueInput = React.forwardRef<HTMLInputElement, SecretValueInputProps>(function SecretValueInput(
  { value, onValueChange, secret = true, className, onBlur, ...props },
  forwardedRef,
) {
  const { t } = useLingui();
  const [revealed, setRevealed] = React.useState(false);
  const innerRef = React.useRef<HTMLInputElement>(null);
  React.useImperativeHandle(forwardedRef, () => innerRef.current as HTMLInputElement);

  return (
    <div className={cn('relative', className)}>
      <Input
        {...props}
        ref={innerRef}
        type={secret && !revealed ? 'password' : 'text'}
        autoComplete="new-password"
        spellCheck={false}
        value={value}
        className={cn(secret && 'pe-9', 'font-mono text-xs')}
        onChange={(e) => onValueChange(e.target.value)}
        onBlur={(e) => {
          const native = innerRef.current?.value ?? '';
          if (native !== value) onValueChange(native);
          onBlur?.(e);
        }}
      />
      {secret && (
        <button
          type="button"
          className="absolute inset-y-0 end-0 flex w-8 items-center justify-center text-muted-foreground hover:text-foreground"
          onClick={() => setRevealed((r) => !r)}
          aria-label={revealed ? t`Hide value` : t`Show value`}
          tabIndex={-1}
        >
          {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  );
});
