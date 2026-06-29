import { useLingui } from '@lingui/react/macro';

interface FusionSpinnerProps {
  size?: 'xs' | 'sm' | 'md' | 'lg' | number;
  className?: string;
}

const SIZE_MAP = {
  xs: 16,
  sm: 24,
  md: 40,
  lg: 80,
};

/**
 * Animated fusion/spark spinner icon.
 * Shows radiating lines from center with staggered animations.
 * Each size has a hand-crafted SVG for optimal visual quality.
 */
export function FusionSpinner({ size = 'sm', className }: FusionSpinnerProps) {
  const dimension = typeof size === 'number' ? size : SIZE_MAP[size];

  // Select variant based on dimension thresholds
  if (dimension <= 16) {
    return <FusionSpinnerXs dimension={dimension} className={className} />;
  } else if (dimension <= 24) {
    return <FusionSpinnerSm dimension={dimension} className={className} />;
  } else if (dimension <= 40) {
    return <FusionSpinnerMd dimension={dimension} className={className} />;
  } else {
    return <FusionSpinnerLg dimension={dimension} className={className} />;
  }
}

// xs variant (16x16)
function FusionSpinnerXs({ dimension, className }: { dimension: number; className?: string }) {
  const { t } = useLingui();
  return (
    <svg width={dimension} height={dimension} viewBox="0 0 16 16" className={className} aria-label={t`Loading`}>
      <circle cx="8" cy="8" r="1" fill="#d4a574" />
      <line x1="8" y1="8" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="7.8;7.5;7.8" dur="0.85s" begin="0.15s" repeatCount="indefinite" />
        <animate attributeName="y2" values="5.5;3.5;5.5" dur="0.85s" begin="0.15s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;1;0.5" dur="0.85s" begin="0.15s" repeatCount="indefinite" />
      </line>
      <line x1="8" y1="8" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="9.5;11;9.5" dur="1.0s" begin="0.4s" repeatCount="indefinite" />
        <animate attributeName="y2" values="6;4.5;6" dur="1.0s" begin="0.4s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;0.95;0.4" dur="1.0s" begin="0.4s" repeatCount="indefinite" />
      </line>
      <line x1="8" y1="8" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="10.5;12;10.5" dur="0.75s" begin="0.7s" repeatCount="indefinite" />
        <animate attributeName="y2" values="7;6.5;7" dur="0.75s" begin="0.7s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.45;1;0.45" dur="0.75s" begin="0.7s" repeatCount="indefinite" />
      </line>
      <line x1="8" y1="8" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="11;12.5;11" dur="1.15s" begin="0.25s" repeatCount="indefinite" />
        <animate attributeName="y2" values="8.5;9;8.5" dur="1.15s" begin="0.25s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0.9;0.5" dur="1.15s" begin="0.25s" repeatCount="indefinite" />
      </line>
      <line x1="8" y1="8" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="10;11.5;10" dur="0.9s" begin="0.55s" repeatCount="indefinite" />
        <animate attributeName="y2" values="10;11.5;10" dur="0.9s" begin="0.55s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;1;0.4" dur="0.9s" begin="0.55s" repeatCount="indefinite" />
      </line>
      <line x1="8" y1="8" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="9;9.5;9" dur="1.25s" begin="0.1s" repeatCount="indefinite" />
        <animate attributeName="y2" values="10.5;12;10.5" dur="1.25s" begin="0.1s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0.85;0.5" dur="1.25s" begin="0.1s" repeatCount="indefinite" />
      </line>
      <line x1="8" y1="8" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="7;6.5;7" dur="0.8s" begin="0.8s" repeatCount="indefinite" />
        <animate attributeName="y2" values="10.5;12;10.5" dur="0.8s" begin="0.8s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.45;1;0.45" dur="0.8s" begin="0.8s" repeatCount="indefinite" />
      </line>
      <line x1="8" y1="8" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="6;4.5;6" dur="1.05s" begin="0.35s" repeatCount="indefinite" />
        <animate attributeName="y2" values="10;11.5;10" dur="1.05s" begin="0.35s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0.9;0.5" dur="1.05s" begin="0.35s" repeatCount="indefinite" />
      </line>
      <line x1="8" y1="8" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="5;3.5;5" dur="0.95s" begin="0.6s" repeatCount="indefinite" />
        <animate attributeName="y2" values="8.5;9;8.5" dur="0.95s" begin="0.6s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;1;0.4" dur="0.95s" begin="0.6s" repeatCount="indefinite" />
      </line>
      <line x1="8" y1="8" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="5.5;4;5.5" dur="0.7s" begin="0.2s" repeatCount="indefinite" />
        <animate attributeName="y2" values="7;6.5;7" dur="0.7s" begin="0.2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0.95;0.5" dur="0.7s" begin="0.2s" repeatCount="indefinite" />
      </line>
      <line x1="8" y1="8" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="6;4.5;6" dur="1.1s" begin="0.5s" repeatCount="indefinite" />
        <animate attributeName="y2" values="6;4.5;6" dur="1.1s" begin="0.5s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.45;0.9;0.45" dur="1.1s" begin="0.5s" repeatCount="indefinite" />
      </line>
      <line x1="8" y1="8" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="6.5;5.5;6.5" dur="0.85s" begin="0.75s" repeatCount="indefinite" />
        <animate attributeName="y2" values="6.5;5;6.5" dur="0.85s" begin="0.75s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;1;0.4" dur="0.85s" begin="0.75s" repeatCount="indefinite" />
      </line>
      <line x1="8" y1="8" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="8.5;9;8.5" dur="0.65s" begin="0.05s" repeatCount="indefinite" />
        <animate attributeName="y2" values="5;3.5;5" dur="0.65s" begin="0.05s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;1;0.5" dur="0.65s" begin="0.05s" repeatCount="indefinite" />
      </line>
      <line x1="8" y1="8" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="11.5;13;11.5" dur="1.2s" begin="0.45s" repeatCount="indefinite" />
        <animate attributeName="y2" values="7.5;7;7.5" dur="1.2s" begin="0.45s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;0.85;0.4" dur="1.2s" begin="0.45s" repeatCount="indefinite" />
      </line>
      <line x1="8" y1="8" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="9.5;11;9.5" dur="0.78s" begin="0.9s" repeatCount="indefinite" />
        <animate attributeName="y2" values="11;12.5;11" dur="0.78s" begin="0.9s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;1;0.5" dur="0.78s" begin="0.9s" repeatCount="indefinite" />
      </line>
      <line x1="8" y1="8" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="4.5;3;4.5" dur="1.0s" begin="0.3s" repeatCount="indefinite" />
        <animate attributeName="y2" values="9.5;10;9.5" dur="1.0s" begin="0.3s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.45;0.95;0.45" dur="1.0s" begin="0.3s" repeatCount="indefinite" />
      </line>
    </svg>
  );
}

// sm variant (24x24)
function FusionSpinnerSm({ dimension, className }: { dimension: number; className?: string }) {
  const { t } = useLingui();
  return (
    <svg width={dimension} height={dimension} viewBox="0 0 24 24" className={className} aria-label={t`Loading`}>
      <circle cx="12" cy="12" r="1" fill="#d4a574" />
      <line x1="12" y1="12" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="11.7;11.4;11.7" dur="0.85s" begin="0.15s" repeatCount="indefinite" />
        <animate attributeName="y2" values="8.5;5.5;8.5" dur="0.85s" begin="0.15s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;1;0.5" dur="0.85s" begin="0.15s" repeatCount="indefinite" />
      </line>
      <line x1="12" y1="12" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="14.5;16.5;14.5" dur="1.0s" begin="0.4s" repeatCount="indefinite" />
        <animate attributeName="y2" values="9;6.5;9" dur="1.0s" begin="0.4s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;0.95;0.4" dur="1.0s" begin="0.4s" repeatCount="indefinite" />
      </line>
      <line x1="12" y1="12" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="15.5;18;15.5" dur="0.75s" begin="0.7s" repeatCount="indefinite" />
        <animate attributeName="y2" values="11;10;11" dur="0.75s" begin="0.7s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.45;1;0.45" dur="0.75s" begin="0.7s" repeatCount="indefinite" />
      </line>
      <line x1="12" y1="12" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="16;18.5;16" dur="1.15s" begin="0.25s" repeatCount="indefinite" />
        <animate attributeName="y2" values="12.5;13;12.5" dur="1.15s" begin="0.25s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0.9;0.5" dur="1.15s" begin="0.25s" repeatCount="indefinite" />
      </line>
      <line x1="12" y1="12" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="15;17.5;15" dur="0.9s" begin="0.55s" repeatCount="indefinite" />
        <animate attributeName="y2" values="15;17;15" dur="0.9s" begin="0.55s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;1;0.4" dur="0.9s" begin="0.55s" repeatCount="indefinite" />
      </line>
      <line x1="12" y1="12" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="13;14.5;13" dur="1.25s" begin="0.1s" repeatCount="indefinite" />
        <animate attributeName="y2" values="15.5;18;15.5" dur="1.25s" begin="0.1s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0.85;0.5" dur="1.25s" begin="0.1s" repeatCount="indefinite" />
      </line>
      <line x1="12" y1="12" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="11;9.5;11" dur="0.8s" begin="0.8s" repeatCount="indefinite" />
        <animate attributeName="y2" values="15.5;18;15.5" dur="0.8s" begin="0.8s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.45;1;0.45" dur="0.8s" begin="0.8s" repeatCount="indefinite" />
      </line>
      <line x1="12" y1="12" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="9;6.5;9" dur="1.05s" begin="0.35s" repeatCount="indefinite" />
        <animate attributeName="y2" values="15;17;15" dur="1.05s" begin="0.35s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0.9;0.5" dur="1.05s" begin="0.35s" repeatCount="indefinite" />
      </line>
      <line x1="12" y1="12" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="8;5.5;8" dur="0.95s" begin="0.6s" repeatCount="indefinite" />
        <animate attributeName="y2" values="12.5;13;12.5" dur="0.95s" begin="0.6s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;1;0.4" dur="0.95s" begin="0.6s" repeatCount="indefinite" />
      </line>
      <line x1="12" y1="12" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="8.5;6;8.5" dur="0.7s" begin="0.2s" repeatCount="indefinite" />
        <animate attributeName="y2" values="11;10;11" dur="0.7s" begin="0.2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0.95;0.5" dur="0.7s" begin="0.2s" repeatCount="indefinite" />
      </line>
      <line x1="12" y1="12" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="9;6.5;9" dur="1.1s" begin="0.5s" repeatCount="indefinite" />
        <animate attributeName="y2" values="9;6.5;9" dur="1.1s" begin="0.5s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.45;0.9;0.45" dur="1.1s" begin="0.5s" repeatCount="indefinite" />
      </line>
      <line x1="12" y1="12" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="10;8.5;10" dur="0.85s" begin="0.75s" repeatCount="indefinite" />
        <animate attributeName="y2" values="9.5;8;9.5" dur="0.85s" begin="0.75s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;1;0.4" dur="0.85s" begin="0.75s" repeatCount="indefinite" />
      </line>
      <line x1="12" y1="12" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="12.5;14;12.5" dur="0.65s" begin="0.05s" repeatCount="indefinite" />
        <animate attributeName="y2" values="8;5.5;8" dur="0.65s" begin="0.05s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;1;0.5" dur="0.65s" begin="0.05s" repeatCount="indefinite" />
      </line>
      <line x1="12" y1="12" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="17;19.5;17" dur="1.2s" begin="0.45s" repeatCount="indefinite" />
        <animate attributeName="y2" values="11.5;11;11.5" dur="1.2s" begin="0.45s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;0.85;0.4" dur="1.2s" begin="0.45s" repeatCount="indefinite" />
      </line>
      <line x1="12" y1="12" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="14.5;16.5;14.5" dur="0.78s" begin="0.9s" repeatCount="indefinite" />
        <animate attributeName="y2" values="16;18.5;16" dur="0.78s" begin="0.9s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;1;0.5" dur="0.78s" begin="0.9s" repeatCount="indefinite" />
      </line>
      <line x1="12" y1="12" stroke="#d4a574" strokeWidth="1" strokeLinecap="round">
        <animate attributeName="x2" values="7;4.5;7" dur="1.0s" begin="0.3s" repeatCount="indefinite" />
        <animate attributeName="y2" values="14;15;14" dur="1.0s" begin="0.3s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.45;0.95;0.45" dur="1.0s" begin="0.3s" repeatCount="indefinite" />
      </line>
    </svg>
  );
}

// md variant (40x40)
function FusionSpinnerMd({ dimension, className }: { dimension: number; className?: string }) {
  const { t } = useLingui();
  return (
    <svg width={dimension} height={dimension} viewBox="0 0 40 40" className={className} aria-label={t`Loading`}>
      <circle cx="20" cy="20" r="1.5" fill="#d4a574" />
      <line x1="20" y1="20" stroke="#d4a574" strokeWidth="1.5" strokeLinecap="round">
        <animate attributeName="x2" values="19.5;19;19.5" dur="0.85s" begin="0.15s" repeatCount="indefinite" />
        <animate attributeName="y2" values="14;9;14" dur="0.85s" begin="0.15s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;1;0.5" dur="0.85s" begin="0.15s" repeatCount="indefinite" />
      </line>
      <line x1="20" y1="20" stroke="#d4a574" strokeWidth="1.5" strokeLinecap="round">
        <animate attributeName="x2" values="24;27;24" dur="1.0s" begin="0.4s" repeatCount="indefinite" />
        <animate attributeName="y2" values="15;11;15" dur="1.0s" begin="0.4s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;0.95;0.4" dur="1.0s" begin="0.4s" repeatCount="indefinite" />
      </line>
      <line x1="20" y1="20" stroke="#d4a574" strokeWidth="1.5" strokeLinecap="round">
        <animate attributeName="x2" values="26;30;26" dur="0.75s" begin="0.7s" repeatCount="indefinite" />
        <animate attributeName="y2" values="18;16;18" dur="0.75s" begin="0.7s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.45;1;0.45" dur="0.75s" begin="0.7s" repeatCount="indefinite" />
      </line>
      <line x1="20" y1="20" stroke="#d4a574" strokeWidth="1.5" strokeLinecap="round">
        <animate attributeName="x2" values="27;31;27" dur="1.15s" begin="0.25s" repeatCount="indefinite" />
        <animate attributeName="y2" values="21;22;21" dur="1.15s" begin="0.25s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0.9;0.5" dur="1.15s" begin="0.25s" repeatCount="indefinite" />
      </line>
      <line x1="20" y1="20" stroke="#d4a574" strokeWidth="1.5" strokeLinecap="round">
        <animate attributeName="x2" values="25;29;25" dur="0.9s" begin="0.55s" repeatCount="indefinite" />
        <animate attributeName="y2" values="25;28;25" dur="0.9s" begin="0.55s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;1;0.4" dur="0.9s" begin="0.55s" repeatCount="indefinite" />
      </line>
      <line x1="20" y1="20" stroke="#d4a574" strokeWidth="1.5" strokeLinecap="round">
        <animate attributeName="x2" values="22;24;22" dur="1.25s" begin="0.1s" repeatCount="indefinite" />
        <animate attributeName="y2" values="26;30;26" dur="1.25s" begin="0.1s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0.85;0.5" dur="1.25s" begin="0.1s" repeatCount="indefinite" />
      </line>
      <line x1="20" y1="20" stroke="#d4a574" strokeWidth="1.5" strokeLinecap="round">
        <animate attributeName="x2" values="18;16;18" dur="0.8s" begin="0.8s" repeatCount="indefinite" />
        <animate attributeName="y2" values="26;30;26" dur="0.8s" begin="0.8s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.45;1;0.45" dur="0.8s" begin="0.8s" repeatCount="indefinite" />
      </line>
      <line x1="20" y1="20" stroke="#d4a574" strokeWidth="1.5" strokeLinecap="round">
        <animate attributeName="x2" values="15;11;15" dur="1.05s" begin="0.35s" repeatCount="indefinite" />
        <animate attributeName="y2" values="25;28;25" dur="1.05s" begin="0.35s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0.9;0.5" dur="1.05s" begin="0.35s" repeatCount="indefinite" />
      </line>
      <line x1="20" y1="20" stroke="#d4a574" strokeWidth="1.5" strokeLinecap="round">
        <animate attributeName="x2" values="13;9;13" dur="0.95s" begin="0.6s" repeatCount="indefinite" />
        <animate attributeName="y2" values="21;22;21" dur="0.95s" begin="0.6s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;1;0.4" dur="0.95s" begin="0.6s" repeatCount="indefinite" />
      </line>
      <line x1="20" y1="20" stroke="#d4a574" strokeWidth="1.5" strokeLinecap="round">
        <animate attributeName="x2" values="14;10;14" dur="0.7s" begin="0.2s" repeatCount="indefinite" />
        <animate attributeName="y2" values="18;16;18" dur="0.7s" begin="0.2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0.95;0.5" dur="0.7s" begin="0.2s" repeatCount="indefinite" />
      </line>
      <line x1="20" y1="20" stroke="#d4a574" strokeWidth="1.5" strokeLinecap="round">
        <animate attributeName="x2" values="15;11;15" dur="1.1s" begin="0.5s" repeatCount="indefinite" />
        <animate attributeName="y2" values="15;11;15" dur="1.1s" begin="0.5s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.45;0.9;0.45" dur="1.1s" begin="0.5s" repeatCount="indefinite" />
      </line>
      <line x1="20" y1="20" stroke="#d4a574" strokeWidth="1.5" strokeLinecap="round">
        <animate attributeName="x2" values="17;14;17" dur="0.85s" begin="0.75s" repeatCount="indefinite" />
        <animate attributeName="y2" values="16;13;16" dur="0.85s" begin="0.75s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;1;0.4" dur="0.85s" begin="0.75s" repeatCount="indefinite" />
      </line>
      <line x1="20" y1="20" stroke="#d4a574" strokeWidth="1.5" strokeLinecap="round">
        <animate attributeName="x2" values="21;23;21" dur="0.65s" begin="0.05s" repeatCount="indefinite" />
        <animate attributeName="y2" values="13;9;13" dur="0.65s" begin="0.05s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;1;0.5" dur="0.65s" begin="0.05s" repeatCount="indefinite" />
      </line>
      <line x1="20" y1="20" stroke="#d4a574" strokeWidth="1.5" strokeLinecap="round">
        <animate attributeName="x2" values="28;32;28" dur="1.2s" begin="0.45s" repeatCount="indefinite" />
        <animate attributeName="y2" values="19;18;19" dur="1.2s" begin="0.45s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;0.85;0.4" dur="1.2s" begin="0.45s" repeatCount="indefinite" />
      </line>
      <line x1="20" y1="20" stroke="#d4a574" strokeWidth="1.5" strokeLinecap="round">
        <animate attributeName="x2" values="24;27;24" dur="0.78s" begin="0.9s" repeatCount="indefinite" />
        <animate attributeName="y2" values="27;31;27" dur="0.78s" begin="0.9s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;1;0.5" dur="0.78s" begin="0.9s" repeatCount="indefinite" />
      </line>
      <line x1="20" y1="20" stroke="#d4a574" strokeWidth="1.5" strokeLinecap="round">
        <animate attributeName="x2" values="12;8;12" dur="1.0s" begin="0.3s" repeatCount="indefinite" />
        <animate attributeName="y2" values="23;25;23" dur="1.0s" begin="0.3s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.45;0.95;0.45" dur="1.0s" begin="0.3s" repeatCount="indefinite" />
      </line>
    </svg>
  );
}

// lg variant (80x80)
function FusionSpinnerLg({ dimension, className }: { dimension: number; className?: string }) {
  const { t } = useLingui();
  return (
    <svg width={dimension} height={dimension} viewBox="0 0 80 80" className={className} aria-label={t`Loading`}>
      <circle cx="40" cy="40" r="2" fill="#d4a574" />
      <line x1="40" y1="40" stroke="#d4a574" strokeWidth="2" strokeLinecap="round">
        <animate attributeName="x2" values="39;38;39" dur="0.85s" begin="0.15s" repeatCount="indefinite" />
        <animate attributeName="y2" values="28;18;28" dur="0.85s" begin="0.15s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;1;0.5" dur="0.85s" begin="0.15s" repeatCount="indefinite" />
      </line>
      <line x1="40" y1="40" stroke="#d4a574" strokeWidth="2" strokeLinecap="round">
        <animate attributeName="x2" values="48;54;48" dur="1.0s" begin="0.4s" repeatCount="indefinite" />
        <animate attributeName="y2" values="30;22;30" dur="1.0s" begin="0.4s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;0.95;0.4" dur="1.0s" begin="0.4s" repeatCount="indefinite" />
      </line>
      <line x1="40" y1="40" stroke="#d4a574" strokeWidth="2" strokeLinecap="round">
        <animate attributeName="x2" values="52;60;52" dur="0.75s" begin="0.7s" repeatCount="indefinite" />
        <animate attributeName="y2" values="36;32;36" dur="0.75s" begin="0.7s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.45;1;0.45" dur="0.75s" begin="0.7s" repeatCount="indefinite" />
      </line>
      <line x1="40" y1="40" stroke="#d4a574" strokeWidth="2" strokeLinecap="round">
        <animate attributeName="x2" values="54;62;54" dur="1.15s" begin="0.25s" repeatCount="indefinite" />
        <animate attributeName="y2" values="42;44;42" dur="1.15s" begin="0.25s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0.9;0.5" dur="1.15s" begin="0.25s" repeatCount="indefinite" />
      </line>
      <line x1="40" y1="40" stroke="#d4a574" strokeWidth="2" strokeLinecap="round">
        <animate attributeName="x2" values="50;58;50" dur="0.9s" begin="0.55s" repeatCount="indefinite" />
        <animate attributeName="y2" values="50;56;50" dur="0.9s" begin="0.55s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;1;0.4" dur="0.9s" begin="0.55s" repeatCount="indefinite" />
      </line>
      <line x1="40" y1="40" stroke="#d4a574" strokeWidth="2" strokeLinecap="round">
        <animate attributeName="x2" values="44;48;44" dur="1.25s" begin="0.1s" repeatCount="indefinite" />
        <animate attributeName="y2" values="52;60;52" dur="1.25s" begin="0.1s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0.85;0.5" dur="1.25s" begin="0.1s" repeatCount="indefinite" />
      </line>
      <line x1="40" y1="40" stroke="#d4a574" strokeWidth="2" strokeLinecap="round">
        <animate attributeName="x2" values="36;32;36" dur="0.8s" begin="0.8s" repeatCount="indefinite" />
        <animate attributeName="y2" values="52;60;52" dur="0.8s" begin="0.8s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.45;1;0.45" dur="0.8s" begin="0.8s" repeatCount="indefinite" />
      </line>
      <line x1="40" y1="40" stroke="#d4a574" strokeWidth="2" strokeLinecap="round">
        <animate attributeName="x2" values="30;22;30" dur="1.05s" begin="0.35s" repeatCount="indefinite" />
        <animate attributeName="y2" values="50;56;50" dur="1.05s" begin="0.35s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0.9;0.5" dur="1.05s" begin="0.35s" repeatCount="indefinite" />
      </line>
      <line x1="40" y1="40" stroke="#d4a574" strokeWidth="2" strokeLinecap="round">
        <animate attributeName="x2" values="26;18;26" dur="0.95s" begin="0.6s" repeatCount="indefinite" />
        <animate attributeName="y2" values="42;44;42" dur="0.95s" begin="0.6s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;1;0.4" dur="0.95s" begin="0.6s" repeatCount="indefinite" />
      </line>
      <line x1="40" y1="40" stroke="#d4a574" strokeWidth="2" strokeLinecap="round">
        <animate attributeName="x2" values="28;20;28" dur="0.7s" begin="0.2s" repeatCount="indefinite" />
        <animate attributeName="y2" values="36;32;36" dur="0.7s" begin="0.2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0.95;0.5" dur="0.7s" begin="0.2s" repeatCount="indefinite" />
      </line>
      <line x1="40" y1="40" stroke="#d4a574" strokeWidth="2" strokeLinecap="round">
        <animate attributeName="x2" values="30;22;30" dur="1.1s" begin="0.5s" repeatCount="indefinite" />
        <animate attributeName="y2" values="30;22;30" dur="1.1s" begin="0.5s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.45;0.9;0.45" dur="1.1s" begin="0.5s" repeatCount="indefinite" />
      </line>
      <line x1="40" y1="40" stroke="#d4a574" strokeWidth="2" strokeLinecap="round">
        <animate attributeName="x2" values="34;28;34" dur="0.85s" begin="0.75s" repeatCount="indefinite" />
        <animate attributeName="y2" values="32;26;32" dur="0.85s" begin="0.75s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;1;0.4" dur="0.85s" begin="0.75s" repeatCount="indefinite" />
      </line>
      <line x1="40" y1="40" stroke="#d4a574" strokeWidth="2" strokeLinecap="round">
        <animate attributeName="x2" values="42;46;42" dur="0.65s" begin="0.05s" repeatCount="indefinite" />
        <animate attributeName="y2" values="26;18;26" dur="0.65s" begin="0.05s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;1;0.5" dur="0.65s" begin="0.05s" repeatCount="indefinite" />
      </line>
      <line x1="40" y1="40" stroke="#d4a574" strokeWidth="2" strokeLinecap="round">
        <animate attributeName="x2" values="56;64;56" dur="1.2s" begin="0.45s" repeatCount="indefinite" />
        <animate attributeName="y2" values="38;36;38" dur="1.2s" begin="0.45s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;0.85;0.4" dur="1.2s" begin="0.45s" repeatCount="indefinite" />
      </line>
      <line x1="40" y1="40" stroke="#d4a574" strokeWidth="2" strokeLinecap="round">
        <animate attributeName="x2" values="48;54;48" dur="0.78s" begin="0.9s" repeatCount="indefinite" />
        <animate attributeName="y2" values="54;62;54" dur="0.78s" begin="0.9s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;1;0.5" dur="0.78s" begin="0.9s" repeatCount="indefinite" />
      </line>
      <line x1="40" y1="40" stroke="#d4a574" strokeWidth="2" strokeLinecap="round">
        <animate attributeName="x2" values="24;16;24" dur="1.0s" begin="0.3s" repeatCount="indefinite" />
        <animate attributeName="y2" values="46;50;46" dur="1.0s" begin="0.3s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.45;0.95;0.45" dur="1.0s" begin="0.3s" repeatCount="indefinite" />
      </line>
    </svg>
  );
}
