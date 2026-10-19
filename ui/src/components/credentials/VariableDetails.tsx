import { Trans, useLingui } from '@lingui/react/macro';
import { CredentialRequirement, type CredentialManifestVar } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Checkbox } from '@src/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';

/** Edits stay in the row draft until the enclosing form is saved. */
export function VariableDetails({ name, spec, onChange, disabled }: {
  name: string;
  spec: CredentialManifestVar;
  onChange: (patch: CredentialManifestVar) => void;
  disabled: boolean;
}) {
  const { t } = useLingui();
  const fields = [
    { key: 'label', label: t`Label` },
    { key: 'hint', label: t`Hint` },
    { key: 'pattern', label: t`Validation pattern` },
    { key: 'help_url', label: t`Help URL` },
  ] as const;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={disabled}
          aria-label={t`Details for ${name}`}><Trans>Details</Trans></Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 p-3" aria-label={t`Details for ${name}`}>
        <div className="break-all text-sm font-medium">{name || t`New variable`}</div>
        <fieldset disabled={disabled} className="space-y-2">
          {fields.map(({ key, label }) => (
            <label key={key} className="block space-y-1 text-xs">
              <span>{label}</span>
              <Input className="h-8 text-xs" value={spec[key] ?? ''}
                onChange={(event) => onChange({ [key]: event.target.value })} />
            </label>
          ))}
          <label className="block space-y-1 text-xs">
            <span><Trans>Required</Trans></span>
            <select className="h-8 w-full rounded-md border bg-background px-2" value={spec.required ?? ''}
              onChange={(event) => onChange({ required: event.target.value as CredentialRequirement })}>
              <option value="" disabled><Trans>Default</Trans></option>
              <option value={CredentialRequirement.MUST}><Trans>Required</Trans></option>
              <option value={CredentialRequirement.OPTIONAL}><Trans>Optional</Trans></option>
              <option value={CredentialRequirement.ONE_OF}><Trans>One of a group</Trans></option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <Checkbox checked={spec.secret ?? true} onCheckedChange={(checked) => onChange({ secret: checked === true })} />
            <Trans>Secret (mask value)</Trans>
          </label>
        </fieldset>
        <p className="text-xs text-muted-foreground"><Trans>Saved with the form. One-of requires at least two variables in the same credential.</Trans></p>
      </PopoverContent>
    </Popover>
  );
}
