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
  value,
  onChange,
  onEnter,
}: {
  id: string;
  testId: string;
  secret?: boolean;
  file?: boolean;
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
}) {
  if (file) return <FileValueInput id={id} testId={testId} secret={secret} value={value} onChange={onChange} />;
  return (
    <Input
      id={id}
      data-testid={testId}
      autoFocus
      type={secret ? 'password' : 'text'}
      autoComplete={secret ? 'off' : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onEnter();
      }}
    />
  );
}
