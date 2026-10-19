import { useLingui } from '@lingui/react/macro';
import React, { useState } from 'react';
import { useOpenInFlowpad } from './useOpenFlowpad';

/**
 * The one "Open in FlowPad" call to action of an entry page, with a quiet link to
 * get FlowPad under it. When the browser reacts to the click (its "Open FlowPad?"
 * prompt, or the app opening) the card stays as it was. Only when nothing reacts
 * — no app is registered for the link — does it switch to the answer for
 * "nothing happened": the download becomes the button, retrying the quiet link.
 */
export const OpenInFlowpadActions: React.FC<{ openTargetPath: string }> = ({ openTargetPath }) => {
  const { t } = useLingui();
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
      <p className="nl-hint">
        {t`Don't have FlowPad yet?`} <a href="https://flowpad.ai/">{t`Get it at flowpad.ai`}</a>
      </p>
    </>
  );
};
