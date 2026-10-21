import { Checkbox } from '@src/components/ui/checkbox';
import { LOGIN_ROLE_CHOICES, type LoginAccess } from '@src/hooks/use-sandboxes';
import { Trans, useLingui } from '@lingui/react/macro';

interface LoginAccessFieldProps {
  value: LoginAccess;
  onChange: (value: LoginAccess) => void;
  /** Test hook for the "allow login" tick; each caller names its own. */
  testId: string;
  className?: string;
}

/**
 * "Allow login", and which of the box's roles it is allowed for.
 *
 * Login here is the box's admin channel — the full FlowPad UI, signed in as
 * whoever logged in — so it is decided per box, not by the type's roles. Shared
 * by both launch dialogs and the card's "Login access" dialog, so the three
 * places it can be set read the same.
 */
export function LoginAccessField({ value, onChange, testId, className }: LoginAccessFieldProps) {
  const { t } = useLingui();
  const labels: Record<(typeof LOGIN_ROLE_CHOICES)[number], string> = {
    owner: t`Owner`,
    'full-access': t`Full access`,
    admin: t`Admin`,
    editor: t`Editor`,
    reader: t`Reader`,
  };
  const toggleRole = (role: string, on: boolean) =>
    onChange({
      ...value,
      roles: LOGIN_ROLE_CHOICES.filter((r) => (r === role ? on : value.roles.includes(r))),
    });

  return (
    <div className={className}>
      <label className="flex items-start gap-2 text-xs" data-testid={testId}>
        <Checkbox
          checked={value.allowLogin}
          onCheckedChange={(v) => onChange({ ...value, allowLogin: v === true })}
          className="mt-0.5"
        />
        <span className="text-muted-foreground">
          <Trans>Allow login — who may sign in to this sandbox from a browser.</Trans>
        </span>
      </label>
      {value.allowLogin ? (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 ps-6" data-testid="login-access-roles">
          {LOGIN_ROLE_CHOICES.map((role) => (
            <label key={role} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={value.roles.includes(role)}
                onCheckedChange={(v) => toggleRole(role, v === true)}
                data-testid={`login-access-role-${role}`}
              />
              {labels[role]}
            </label>
          ))}
        </div>
      ) : (
        <p className="mt-1.5 ps-6 text-xs text-amber-600 dark:text-amber-500" data-testid="login-access-off">
          <Trans>Nobody can log in to this sandbox, including its owner.</Trans>
        </p>
      )}
    </div>
  );
}
