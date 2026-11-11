import type { CSSProperties } from 'react';
import { DayPicker, type DayPickerProps } from 'react-day-picker';
import 'react-day-picker/style.css';

/** The day grid, in the app's colours. */
const THEME = {
  '--rdp-accent-color': 'hsl(var(--primary))',
  '--rdp-accent-background-color': 'hsl(var(--primary) / 0.15)',
  '--rdp-day-height': '1.75rem',
  '--rdp-day-width': '1.75rem',
  '--rdp-day_button-height': '1.625rem',
  '--rdp-day_button-width': '1.625rem',
  '--rdp-nav-height': '1.75rem',
  '--rdp-nav_button-height': '1.5rem',
  '--rdp-nav_button-width': '1.5rem',
} as CSSProperties;

export function Calendar(props: DayPickerProps) {
  return (
    <DayPicker
      {...props}
      className={`text-xs [&_.rdp-caption_label]:text-sm [&_.rdp-caption_label]:font-medium ${props.className ?? ''}`}
      style={{ ...THEME, ...props.style }}
    />
  );
}
