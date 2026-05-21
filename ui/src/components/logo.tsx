import { BASE_PATH } from '@src/constants/basePath';
import { ensureValidUrl } from '@src/utils/navigation';
import { ISiteConfig } from '@sdk';
import { useTheme } from 'next-themes';
import { useCallback } from 'react';
import flowpadLogo from '@src/assets/logo.png';

function isAbsoluteUrl(url: string) {
  return /^https?:\/\//i.test(url);
}

export function Logo({ siteConfig, onClick }: { siteConfig: ISiteConfig | null | undefined; onClick?: () => void }) {
  const { resolvedTheme } = useTheme();

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      onClick?.();
    },
    [onClick],
  );

  if (siteConfig?.branding?.logo_url) {
    return (
      <a href={ensureValidUrl(siteConfig.domain)} onClick={handleClick}>
        <img
          src={
            isAbsoluteUrl(siteConfig.branding.logo_url)
              ? siteConfig.branding.logo_url
              : `${BASE_PATH}${siteConfig.branding.logo_url}`
          }
          alt={siteConfig.branding.company_name || 'Logo'}
          className={`max-h-8 max-w-32 object-contain ${resolvedTheme === 'dark' && siteConfig.branding.use_brightness_filter ? 'brightness-0 invert' : ''}`}
        />
      </a>
    );
  }

  return (
    <a href={siteConfig?.domain ? ensureValidUrl(siteConfig.domain) : '#'} onClick={handleClick}>
      <img
        src={flowpadLogo}
        alt={siteConfig?.branding?.company_name || 'Logo'}
        className="max-h-8 max-w-32 object-contain"
      />
    </a>
  );
}
