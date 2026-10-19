import * as React from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { Globe, KeyRound, MonitorSmartphone, type LucideIcon } from 'lucide-react';
import type { OAuthFlowKind } from '@sdk';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

/**
 * HOW a connection signs in — the Sign-in column's one question.
 *
 * The column used to hold whatever each row producer had to hand: a brand
 * ("FlowPad"), an account and plan ("Anthropic account · Max"), a grant flavour
 * ("OAuth + PKCE"), a storage place ("Vault"). There are only three methods, so
 * the cell is one of three icons and the specifics move into its tooltip.
 */
export type SignInMethod = 'oauth' | 'device' | 'api_key';

/**
 * Lazy descriptors, resolved at render: a module-level `t` would freeze the boot
 * locale's English into the label (see `STATUS_TEXT` in `HarnessLoginModal`).
 */
const METHOD_META: Record<SignInMethod, { Icon: LucideIcon; label: MessageDescriptor }> = {
  oauth: { Icon: Globe, label: msg`OAuth` },
  device: { Icon: MonitorSmartphone, label: msg`Device login` },
  api_key: { Icon: KeyRound, label: msg`API key` },
};

/** An OAuth provider's grant, as a method: the RFC 8628 device grant is a device login. */
export function methodForOAuthFlow(kind: OAuthFlowKind): SignInMethod {
  return kind === 'device' ? 'device' : 'oauth';
}

/**
 * The method's icon, with the app's own tooltip — hover AND keyboard focus, the
 * same reveal `MoreOnHover` uses, not a native `title` that often never shows in
 * the desktop shell. `lines` are the row's specifics; empty ones are dropped.
 */
export function SignInMethodIcon({
  method,
  lines = [],
  testId,
}: {
  method: SignInMethod;
  lines?: (string | null | undefined)[];
  testId?: string;
}) {
  const { Icon, label } = METHOD_META[method];
  const text = i18n._(label);
  const details = lines.filter((line): line is string => Boolean(line?.trim()));
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            role="img"
            // The tooltip's whole text, so a screen reader hears the specifics too.
            aria-label={[text, ...details].join(' — ')}
            data-method={method}
            data-testid={testId}
            className="flex w-fit items-center text-muted-foreground outline-none"
          >
            <Icon className="h-4 w-4" />
          </span>
        </TooltipTrigger>
        <TooltipContent align="start">
          <div className="font-medium">{text}</div>
          {details.map((line, i) => (
            <div key={i} className="text-[11px] opacity-80">
              {line}
            </div>
          ))}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
