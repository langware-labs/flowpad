import flowpadLogo from '@src/assets/logo.png';
import { WarningsPopover } from '@src/components/warnings-popover';
import { Agent, TypeId } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { useTheme } from 'next-themes';
import { useMemo } from 'react';
import { useParams } from 'react-router';
import { useColorPalette } from '@src/hooks/useColorPalette';
import { Trans, useLingui } from '@lingui/react/macro';

interface FooterProps {
  className?: string;
}

export function Footer({ className = '' }: FooterProps) {
  const { t } = useLingui();
  const { agentId } = useParams();
  const agentTypeId = useMemo(() => (agentId ? new TypeId(Agent.type, agentId) : null), [agentId]);
  const { data: agent } = useEntity<Agent>(agentTypeId);
  const { resolvedTheme } = useTheme();
  useColorPalette(agent?.site_config);

  return (
    <footer
      className={`relative z-10 w-full border-t bg-background/95 px-6 py-1 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/60 ${className}`}
    >
      <div className="flex items-center justify-between">
        {/* Warnings icon on the left */}
        <div className="relative">
          <WarningsPopover />
        </div>

        {/* Powered by on the right */}
        <div className="ml-auto flex items-end">
          <span className="mr-2 text-[10px] text-muted-foreground"><Trans>Powered by</Trans></span>
          <a
            href="https://flowpad.ai"
            onClick={(e) => {
              const electronAPI = (window as any).electronAPI;
              if (electronAPI?.openExternal) {
                e.preventDefault();
                electronAPI.openExternal('https://flowpad.ai');
              }
            }}
          >
            <img
              src={flowpadLogo}
              alt={t`Flowpad.ai Logo`}
              className={`h-4 ${resolvedTheme === 'dark' ? 'brightness-0 invert' : ''}`}
            />
          </a>
        </div>
      </div>
    </footer>
  );
}
