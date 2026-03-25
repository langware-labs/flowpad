/**
 * ANSI escape sequence parser.
 * Emits typed events; ANSI bytes produce NO 'print' events → zero column cost.
 */

export type ParsedEvent =
  | { type: 'print'; char: string }   // single codepoint (may be 2 JS chars for surrogate pairs)
  | { type: 'cr' }                     // \r
  | { type: 'lf' }                     // \n
  | { type: 'tab' }                    // \t
  | { type: 'csi'; cmd: string; params: number[]; priv: boolean }
  | { type: 'ignored' };

type State = 'GROUND' | 'ESC' | 'CSI_ENTRY' | 'CSI_PARAM' | 'CSI_INTER' | 'OSC_STRING';

function parseCSIParams(raw: string): number[] {
  if (!raw) return [];
  return raw.split(';').map(p => (p === '' ? 0 : parseInt(p, 10)));
}

export function parseAnsi(input: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  let state: State = 'GROUND';
  let paramBuf = '';
  let priv = false;

  let i = 0;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    const ch = input[i];

    switch (state) {
      case 'GROUND': {
        if (code === 0x1b) {
          state = 'ESC';
        } else if (ch === '\r') {
          events.push({ type: 'cr' });
        } else if (ch === '\n') {
          events.push({ type: 'lf' });
        } else if (ch === '\t') {
          events.push({ type: 'tab' });
        } else if (code >= 0x20 && code !== 0x7f) {
          // Printable — handle surrogate pairs for emoji
          if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
            const next = input.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
              events.push({ type: 'print', char: ch + input[i + 1] });
              i++;
            } else {
              events.push({ type: 'print', char: ch });
            }
          } else {
            events.push({ type: 'print', char: ch });
          }
        } else {
          events.push({ type: 'ignored' });
        }
        break;
      }

      case 'ESC': {
        if (ch === '[') {
          state = 'CSI_ENTRY';
          paramBuf = '';
          priv = false;
        } else if (ch === ']') {
          state = 'OSC_STRING';
        } else {
          // Single-char ESC sequence — ignore
          state = 'GROUND';
          events.push({ type: 'ignored' });
        }
        break;
      }

      case 'CSI_ENTRY': {
        if (ch === '?' || ch === '>' || ch === '!') {
          priv = true;
          state = 'CSI_PARAM';
        } else if (code >= 0x30 && code <= 0x3f) {
          paramBuf += ch;
          state = 'CSI_PARAM';
        } else if (code >= 0x40 && code <= 0x7e) {
          events.push({ type: 'csi', cmd: ch, params: parseCSIParams(paramBuf), priv });
          state = 'GROUND';
        } else if (code >= 0x20 && code <= 0x2f) {
          state = 'CSI_INTER';
        }
        break;
      }

      case 'CSI_PARAM': {
        if (code >= 0x30 && code <= 0x3f) {
          paramBuf += ch;
        } else if (code >= 0x20 && code <= 0x2f) {
          state = 'CSI_INTER';
        } else if (code >= 0x40 && code <= 0x7e) {
          events.push({ type: 'csi', cmd: ch, params: parseCSIParams(paramBuf), priv });
          state = 'GROUND';
        }
        break;
      }

      case 'CSI_INTER': {
        if (code >= 0x20 && code <= 0x2f) {
          // more intermediate — consume
        } else if (code >= 0x40 && code <= 0x7e) {
          events.push({ type: 'csi', cmd: ch, params: parseCSIParams(paramBuf), priv });
          state = 'GROUND';
        }
        break;
      }

      case 'OSC_STRING': {
        // Consume until BEL (0x07) or ESC \ (ST)
        if (code === 0x07) {
          state = 'GROUND';
        } else if (code === 0x1b) {
          // peek at next for ST
          if (i + 1 < input.length && input[i + 1] === '\\') {
            i++; // consume the '\'
          }
          state = 'GROUND';
        }
        break;
      }
    }
    i++;
  }

  return events;
}
