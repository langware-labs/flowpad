// Shared xterm color themes for both the main InteractiveTerminal
// and the SidecarShellTerminal. Keep these as plain hex literals — xterm's
// theme option does not resolve CSS variables.

import type { ITheme } from '@xterm/xterm';

export const DARK_THEME: ITheme = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  selectionBackground: 'rgba(255, 255, 255, 0.3)',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

export const LIGHT_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#1e1e1e',
  cursor: '#1e1e1e',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(0, 122, 204, 0.18)',
  black: '#000000',
  red: '#cd3131',
  green: '#067d17',
  yellow: '#7d7100',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#3a3a3a',
  brightBlack: '#4a4a4a',
  brightRed: '#cd3131',
  brightGreen: '#067d17',
  brightYellow: '#7d7100',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#1e1e1e',
};
