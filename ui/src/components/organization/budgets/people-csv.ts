/**
 * The bulk-add sheet: `name,email,budget` text in, rows and problems out.
 *
 * **Pure.** No React, no i18n, no network — a problem is reported as a CODE and the dialog renders
 * the sentence, so the rules are unit-testable and the wording stays translatable in one place.
 *
 * A bad row never stops a good one. Someone uploading forty new hires with one fat-fingered address
 * should get thirty-nine people and one line to fix, not a rejected file — so `parsePeopleCsv`
 * always returns both lists and lets the caller import what parsed.
 */
import Papa from 'papaparse';

/** What a row can be wrong about. The dialog owns the wording. */
export type PeopleCsvProblemCode = 'missing_email' | 'bad_email' | 'bad_budget' | 'duplicate_email';

export interface PeopleCsvRow {
  name: string;
  /** Lower-cased and trimmed — the hub matches accounts on the address, not on its casing. */
  email: string;
  /** The lifetime allowance in USD. `null` = the column was blank: no cap for this person. */
  budget: number | null;
  /** 1-based line in the file as the person sees it in a spreadsheet (the header is line 1). */
  line: number;
}

export interface PeopleCsvProblem {
  line: number;
  code: PeopleCsvProblemCode;
  /** What was actually in the cell, for "…, got 'ten dollars'". */
  value: string;
}

export interface PeopleCsvResult {
  rows: PeopleCsvRow[];
  problems: PeopleCsvProblem[];
}

/** The file the Download sample button hands over. Two rows, because one row reads as a template
 *  and three would imply the count matters. */
export const SAMPLE_PEOPLE_CSV = [
  'name,email,budget',
  'Ada Lovelace,ada@example.com,50',
  'Alan Turing,alan@example.com,25',
].join('\n');

export const PEOPLE_CSV_FILENAME = 'flowpad-people-sample.csv';

/** Deliberately loose: the hub is the authority on whether an address can receive an invitation,
 *  and a client-side regex that is stricter than the mail system rejects real addresses. This
 *  catches the typo class — no `@`, no domain, whitespace inside — and nothing more. */
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function headerOf(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Parse `name,email,budget`.
 *
 * The header is matched case- and space-insensitively so a sheet saved from Excel with `Name` or
 * `E-mail ` still lands. Columns beyond the three are ignored rather than refused: people paste
 * exports that carry a department or a start date, and none of that is ours to police.
 */
export function parsePeopleCsv(text: string): PeopleCsvResult {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: headerOf,
    // Never coerce: a budget is validated here, and a name like "007" must survive as typed.
    dynamicTyping: false,
  });

  const rows: PeopleCsvRow[] = [];
  const problems: PeopleCsvProblem[] = [];
  const seen = new Set<string>();

  (parsed.data ?? []).forEach((record, index) => {
    // +2: the header is line 1 and `index` is 0-based, so the first data row is line 2 — which is
    // what the uploader sees in their spreadsheet.
    const line = index + 2;
    const email = (record.email ?? record['e-mail'] ?? '').trim().toLowerCase();
    const name = (record.name ?? '').trim();
    const rawBudget = (record.budget ?? '').trim();

    if (!email) {
      problems.push({ line, code: 'missing_email', value: '' });
      return;
    }
    if (!EMAIL.test(email)) {
      problems.push({ line, code: 'bad_email', value: email });
      return;
    }
    if (seen.has(email)) {
      problems.push({ line, code: 'duplicate_email', value: email });
      return;
    }

    let budget: number | null = null;
    if (rawBudget !== '') {
      // Accept "$50" and "1,200" — that is what a spreadsheet's currency formatting produces, and
      // refusing it would send people back to reformat a file that says what they meant.
      const cleaned = rawBudget.replace(/[$,\s]/g, '');
      const value = Number(cleaned);
      if (cleaned === '' || !Number.isFinite(value) || value < 0) {
        problems.push({ line, code: 'bad_budget', value: rawBudget });
        return;
      }
      budget = value;
    }

    seen.add(email);
    rows.push({ name: name || email, email, budget, line });
  });

  return { rows, problems };
}
