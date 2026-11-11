import { CheckCircle2, CircleDashed, TriangleAlert, XCircle, type LucideIcon } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import type { CredentialTestState } from '@sdk';

export interface TestVerdict {
  icon: LucideIcon;
  /** Text colour class for the icon and line. */
  tone: string;
  text: string;
}

/**
 * One wording per credential test state, from where it is read: `self` — the test ran on this machine;
 * `sender` — a receiver's Flowpad ran it after the shared values landed there. Same icon and colour on both sides.
 */
export function useTestVerdict(): (state: CredentialTestState, who: 'self' | 'sender') => TestVerdict {
  const { t } = useLingui();
  return (state, who) => {
    const self = who === 'self';
    return {
      ok: { icon: CheckCircle2, tone: 'text-emerald-600', text: self ? t`Tested here: the provider takes the key.` : t`Validated` },
      invalid: {
        icon: XCircle,
        tone: 'text-destructive',
        text: self ? t`Tested here: the provider refused the key — ask the sender for a new one.` : t`Key refused by the provider`,
      },
      error: {
        icon: TriangleAlert,
        tone: 'text-amber-600',
        text: self ? t`Could not test it on this machine.` : t`Couldn't test on their machine`,
      },
      untested: {
        icon: CircleDashed,
        tone: 'text-muted-foreground',
        text: self ? t`Ready on this machine — this credential has no test.` : t`No test for this credential`,
      },
    }[state];
  };
}
