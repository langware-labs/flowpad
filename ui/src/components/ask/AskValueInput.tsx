import { Input } from '@src/components/ui/input';
import { FileValueInput } from '@src/components/credentials/FileValueInput';

/**
 * The one field a question's value is typed into — wherever the question is drawn (`AskForm`,
 * `AskModal`, `AskView`): a line, masked when it is a secret, or — for a FILE answer (a key file) —
 * a file picker whose content is the answer (`FileValueInput`).
 */
export function AskValueInput({
  id,
  testId,
  secret,
  file,
  placeholder,
  value,
  onChange,
  onEnter,
  onPaste,
}: {
  id: string;
  testId: string;
  secret?: boolean;
  file?: boolean;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  /** A value was pasted (the change with it follows): a form that verifies does so once, by itself. */
  onPaste?: () => void;
}) {
  if (file) return <FileValueInput id={id} testId={testId} secret={secret} value={value} onChange={onChange} />;
  return (
    <Input
      id={id}
      data-testid={testId}
      autoFocus
      type={secret ? 'password' : 'text'}
      autoComplete={secret ? 'off' : undefined}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onPaste={onPaste}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onEnter();
      }}
    />
  );
}
