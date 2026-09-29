import { useLingui } from '@lingui/react/macro';
import { CredentialRequirement } from '@sdk';
import { cn } from '@src/lib/utils';
import { Badge } from '../ui/badge';

/**
 * A credential's (or one variable's) `required`: `MUST` — the project does not work
 * without it — or `OPTIONAL`. The word is the enum value itself, so the chip reads
 * the same as the manifest.
 */
export function RequirementChip({
  required,
  testId,
  className,
}: {
  required: CredentialRequirement;
  testId?: string;
  className?: string;
}) {
  const { t } = useLingui();
  const must = required === CredentialRequirement.MUST;
  return (
    <Badge
      variant="outline"
      data-testid={testId}
      data-required={required}
      title={must ? t`The project does not work without it` : t`Turns a feature or an integration on`}
      className={cn(
        'h-[18px] shrink-0 px-1.5 text-[10px] font-medium tracking-wide',
        must ? 'border-amber-500/50 text-amber-700 dark:text-amber-400' : 'text-muted-foreground',
        className,
      )}
    >
      {required}
    </Badge>
  );
}
