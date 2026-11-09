import { useLingui } from '@lingui/react/macro';
import { Download } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import {
  ALL_INSTALLERS,
  detectPlatform,
  INSTALLERS,
  type InstallerId,
  offerFor,
  type Platform,
  startDownload,
} from './desktop-download';

/** The visitor's platform, detected once on mount (`null` while the hints are read). */
export function usePlatform(): Platform | null {
  const [platform, setPlatform] = useState<Platform | null>(null);
  useEffect(() => {
    let live = true;
    void detectPlatform().then((p) => live && setPlatform(p));
    return () => {
      live = false;
    };
  }, []);
  return platform;
}

function useInstallerText() {
  const { t } = useLingui();
  const button: Record<InstallerId, string> = {
    dmg: t`Download FlowPad for macOS`,
    exe: t`Download FlowPad for Windows`,
    appimage: t`Download FlowPad for Linux`,
    deb: t`Download FlowPad for Linux`,
    rpm: t`Download FlowPad for Linux`,
  };
  const file: Record<InstallerId, string> = {
    dmg: t`macOS (.dmg) — Intel and Apple Silicon`,
    exe: t`Windows (.exe)`,
    appimage: t`Linux AppImage — most distributions (x86_64)`,
    deb: t`Linux DEB — Ubuntu, Debian, Linux Mint`,
    rpm: t`Linux RPM — Fedora, RHEL, Rocky Linux`,
  };
  const format: Partial<Record<InstallerId, string>> = { appimage: 'AppImage', deb: 'DEB', rpm: 'RPM' };
  const install: Partial<Record<InstallerId, string>> = {
    appimage: 'chmod +x Flowpad-x86_64.AppImage && ./Flowpad-x86_64.AppImage',
    deb: 'sudo apt install ./Flowpad-amd64.deb',
    rpm: 'sudo dnf install ./Flowpad-x86_64.rpm',
  };
  return { button, file, format, install };
}

/** A link to an installer that downloads in place (see `startDownload`). The `href` stays real,
 *  so copy-link and open-in-new-tab still work. */
const InstallerLink: React.FC<{
  id: InstallerId;
  className?: string;
  onStart: (id: InstallerId) => void;
  children: React.ReactNode;
}> = ({ id, className, onStart, children }) => (
  <a
    className={className}
    href={INSTALLERS[id].url}
    data-testid={`download-${id}`}
    onClick={(e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // the browser's own new-tab gestures
      e.preventDefault();
      startDownload(INSTALLERS[id].url);
      onStart(id);
    }}
  >
    {children}
  </a>
);

/** The one-line install command a Linux package needs, or nothing. */
export const InstallHint: React.FC<{ id: InstallerId }> = ({ id }) => {
  const { t } = useLingui();
  const command = useInstallerText().install[id];
  if (!command) return null;
  return (
    <p className="nl-hint" data-testid="download-install-hint">
      {t`Then install it:`} <code className="nl-code">{command}</code>
    </p>
  );
};

/** Every installer, for when detection got it wrong or the visitor is on another computer. */
const AllInstallers: React.FC<{ onStart: (id: InstallerId) => void }> = ({ onStart }) => {
  const { file } = useInstallerText();
  return (
    <ul className="nl-installers" data-testid="download-all">
      {ALL_INSTALLERS.map((id) => (
        <li key={id}>
          <InstallerLink id={id} onStart={onStart}>
            {file[id]}
          </InstallerLink>
        </li>
      ))}
    </ul>
  );
};

/**
 * "Install FlowPad": the download button for this computer's OS (Linux: AppImage by default,
 * DEB and RPM to choose from), what the visitor needs to know when there is no exact fit, and
 * every installer behind "Other platforms". Downloads start in place — the page stays.
 */
export const DesktopDownload: React.FC<{ onStart: (id: InstallerId) => void }> = ({ onStart }) => {
  const { t } = useLingui();
  const platform = usePlatform();
  const text = useInstallerText();
  const offer = platform ? offerFor(platform) : null;
  const [chosen, setChosen] = useState<InstallerId | null>(null);
  const [showAll, setShowAll] = useState(false);
  if (!offer) return null;

  const primary = chosen && offer.installers.includes(chosen) ? chosen : offer.installers[0];
  const formats = offer.installers.filter((id) => text.format[id]);
  const note =
    offer.note &&
    {
      'arm-emulated': t`On Windows on ARM, FlowPad runs through Windows' built-in x64 emulation.`,
      'x64-only': t`These installers are for 64-bit Intel/AMD (x86_64) Linux.`,
      'no-arch': t`FlowPad Desktop isn't available for this processor yet — it runs on 64-bit Intel/AMD (x86_64) Linux.`,
      'no-os': t`FlowPad Desktop runs on macOS, Windows and Linux. Open this page on your computer, or download it below.`,
    }[offer.note];

  return (
    <div className="nl-download" data-testid="desktop-download" data-os={platform?.os}>
      {primary && (
        <div className="nl-buttons">
          <InstallerLink id={primary} className="nl-btn" onStart={onStart}>
            <Download size={16} aria-hidden /> {text.button[primary]}
          </InstallerLink>
        </div>
      )}
      {formats.length > 1 && (
        <div className="nl-formats" role="radiogroup" aria-label={t`Package format`}>
          {formats.map((id) => (
            <label key={id} className="nl-format">
              <input
                type="radio"
                name="flowpad-linux-format"
                checked={id === primary}
                onChange={() => setChosen(id)}
                data-testid={`format-${id}`}
              />
              {text.format[id]}
            </label>
          ))}
        </div>
      )}
      {note && (
        <p className="nl-hint" data-testid="download-note">
          {note}
        </p>
      )}
      {primary && <InstallHint id={primary} />}
      {offer.note === 'no-os' || offer.note === 'no-arch' || showAll ? (
        <AllInstallers onStart={onStart} />
      ) : (
        <p className="nl-hint">
          <button type="button" className="nl-hint-link" onClick={() => setShowAll(true)}>
            {t`Other platforms`}
          </button>
        </p>
      )}
    </div>
  );
};

/** The quiet one-click download under "Open in FlowPad": "Download for macOS" for this OS, or
 *  — with no fit — a link that opens the full chooser. */
export const QuickDownloadLink: React.FC<{ onStart: (id: InstallerId) => void; onChoose: () => void }> = ({
  onStart,
  onChoose,
}) => {
  const { t } = useLingui();
  const platform = usePlatform();
  const offer = platform ? offerFor(platform) : null;
  // A sure fit downloads in one click; an unknown-architecture Linux opens the chooser instead.
  const id = offer && offer.note !== 'x64-only' ? (offer.installers[0] ?? null) : null;
  const label =
    id &&
    { dmg: t`Download for macOS`, exe: t`Download for Windows`, appimage: t`Download for Linux (AppImage)` }[
      id as 'dmg' | 'exe' | 'appimage'
    ];
  if (id && label) {
    return (
      <InstallerLink id={id} onStart={onStart}>
        {label}
      </InstallerLink>
    );
  }
  return (
    <button type="button" className="nl-hint-link" onClick={onChoose} data-testid="download-choose">
      {t`Download FlowPad`}
    </button>
  );
};
