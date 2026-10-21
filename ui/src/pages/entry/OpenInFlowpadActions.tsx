import { useLingui } from '@lingui/react/macro';
import { Loader2, RotateCw } from 'lucide-react';
import React, { useState } from 'react';
import { type DesktopPresence, useDesktopPresence } from './use-desktop-presence';
import { useOpenInFlowpad } from './useOpenFlowpad';

/**
 * One line under the button: is a FlowPad desktop of this user connected to the hub now,
 * with a refresh. It follows the desktop live (see `useDesktopPresence`). It only informs —
 * the button opens through the deep link either way, which also starts a closed FlowPad.
 */
const ConnectionStatus: React.FC<{ presence: DesktopPresence; notInstalled: boolean; recheck: () => void }> = ({
  presence,
  notInstalled,
  recheck,
}) => {
  const { t } = useLingui();
  const text = notInstalled
    ? t`FlowPad isn't installed on this computer`
    : {
        checking: t`Checking FlowPad…`,
        online: t`FlowPad is connected`,
        offline: t`FlowPad isn't connected — Open starts it if it's installed`,
        unknown: t`Couldn't check FlowPad's connection`,
      }[presence];
  const online = presence === 'online' && !notInstalled;
  return (
    <p className="nl-hint nl-connection" data-testid="landing-connection" data-presence={presence}>
      {presence === 'checking' ? (
        <Loader2 className="nl-connection-spin" size={12} aria-hidden />
      ) : (
        <span className={online ? 'nl-dot nl-dot-on' : 'nl-dot'} aria-hidden />
      )}
      <span>{text}</span>
      <button
        type="button"
        className="nl-refresh"
        onClick={recheck}
        disabled={presence === 'checking'}
        aria-label={t`Check again`}
        title={t`Check again`}
        data-testid="landing-check-again"
      >
        <RotateCw size={12} />
      </button>
    </p>
  );
};

/**
 * The one "Open in FlowPad" call to action of an entry page, with a quiet link to
 * get FlowPad under it. When the browser reacts to the click (its "Open FlowPad?"
 * prompt, or the app opening) the card stays as it was. Only when nothing reacts
 * — no app is registered for the link — does it switch to the answer for
 * "nothing happened": the download becomes the button, retrying the quiet link.
 */
export const OpenInFlowpadActions: React.FC<{ openTargetPath: string; showConnection?: boolean }> = ({
  openTargetPath,
  showConnection = false,
}) => {
  const { t } = useLingui();
  const { presence, recheck } = useDesktopPresence(showConnection);
  const openInFlowpad = useOpenInFlowpad(openTargetPath);
  const [opening, setOpening] = useState(false);
  const [missing, setMissing] = useState(false);
  const open = () => {
    setOpening(true);
    void openInFlowpad()
      .then((handedOff) => setMissing(!handedOff))
      .finally(() => setOpening(false));
  };

  if (missing) {
    return (
      <>
        <p className="nl-not-opened">{t`FlowPad didn't open? Install it, then come back to this page.`}</p>
        <div className="nl-buttons">
          <a className="nl-btn" href="https://flowpad.ai/">
            {t`Get FlowPad at flowpad.ai →`}
          </a>
        </div>
        {showConnection && <ConnectionStatus presence={presence} notInstalled recheck={recheck} />}
        <p className="nl-hint">
          {t`Already installed?`}{' '}
          <button type="button" className="nl-hint-link" onClick={open}>
            {t`Try again`}
          </button>
        </p>
      </>
    );
  }

  return (
    <>
      <div className="nl-buttons">
        <button type="button" className="nl-btn" onClick={open} disabled={opening}>
          {t`Open in FlowPad`}
        </button>
      </div>
      {showConnection && <ConnectionStatus presence={presence} notInstalled={false} recheck={recheck} />}
      <p className="nl-hint">
        {t`Don't have FlowPad yet?`} <a href="https://flowpad.ai/">{t`Get it at flowpad.ai`}</a>
      </p>
    </>
  );
};
