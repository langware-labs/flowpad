/**
 * The bulk-add parser. Pure, so these are the rules themselves rather than a rendering of them.
 *
 * The behaviour worth locking is that a bad row never costs a good one: someone importing forty
 * new hires with one fat-fingered address must get thirty-nine people and one line to fix.
 */
import { describe, expect, it } from 'vitest';

import {
  PEOPLE_CSV_FILENAME,
  SAMPLE_PEOPLE_CSV,
  parsePeopleCsv,
} from '@src/components/organization/budgets/people-csv';

describe('parsePeopleCsv', () => {
  it('reads name, email and budget', () => {
    const { rows, problems } = parsePeopleCsv('name,email,budget\nAda,ada@example.com,50\n');
    expect(problems).toEqual([]);
    expect(rows).toEqual([{ name: 'Ada', email: 'ada@example.com', budget: 50, line: 2 }]);
  });

  it('keeps the good rows when one is bad, and numbers the lines as a spreadsheet does', () => {
    const { rows, problems } = parsePeopleCsv(
      ['name,email,budget', 'Ada,ada@example.com,50', 'Broken,not-an-email,10', 'Alan,alan@example.com,25'].join('\n'),
    );
    expect(rows.map((r) => r.email)).toEqual(['ada@example.com', 'alan@example.com']);
    expect(problems).toEqual([{ line: 3, code: 'bad_email', value: 'not-an-email' }]);
    // Line 4 in the file is the third data row — the number has to match what the uploader sees.
    expect(rows[1].line).toBe(4);
  });

  it('treats a blank budget as no limit, not as zero', () => {
    // 0 is a real and different state: the hub reports it as "no budget allocated" rather than as
    // an exhausted one, so a blank cell must never collapse into it.
    const { rows } = parsePeopleCsv('name,email,budget\nAda,ada@example.com,\nAlan,alan@example.com,0\n');
    expect(rows[0].budget).toBeNull();
    expect(rows[1].budget).toBe(0);
  });

  it('accepts what a spreadsheet actually produces', () => {
    const { rows, problems } = parsePeopleCsv('Name,E-Mail,Budget\nAda,ADA@Example.com,"$1,200"\n');
    expect(problems).toEqual([]);
    // Header case/spacing, a currency-formatted amount, and an address normalised for matching.
    expect(rows[0]).toMatchObject({ email: 'ada@example.com', budget: 1200 });
  });

  it('reports a repeated address once and imports it once', () => {
    const { rows, problems } = parsePeopleCsv(
      ['name,email,budget', 'Ada,ada@example.com,50', 'Ada again,ada@example.com,70'].join('\n'),
    );
    expect(rows).toHaveLength(1);
    expect(problems).toEqual([{ line: 3, code: 'duplicate_email', value: 'ada@example.com' }]);
  });

  it('rejects an unreadable amount rather than importing an unbudgeted person', () => {
    const { rows, problems } = parsePeopleCsv('name,email,budget\nAda,ada@example.com,ten dollars\n');
    expect(rows).toEqual([]);
    expect(problems).toEqual([{ line: 2, code: 'bad_budget', value: 'ten dollars' }]);
  });

  it('rejects a negative amount', () => {
    const { problems } = parsePeopleCsv('name,email,budget\nAda,ada@example.com,-5\n');
    expect(problems[0]).toMatchObject({ code: 'bad_budget' });
  });

  it('falls back to the address when the name column is blank', () => {
    const { rows } = parsePeopleCsv('name,email,budget\n,ada@example.com,5\n');
    expect(rows[0].name).toBe('ada@example.com');
  });

  it('ignores extra columns people paste from an HR export', () => {
    const { rows, problems } = parsePeopleCsv('name,email,budget,department\nAda,ada@example.com,5,Research\n');
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  it('reports a row with no address', () => {
    const { problems } = parsePeopleCsv('name,email,budget\nNobody,,5\n');
    expect(problems).toEqual([{ line: 2, code: 'missing_email', value: '' }]);
  });

  it('round-trips its own sample', () => {
    const { rows, problems } = parsePeopleCsv(SAMPLE_PEOPLE_CSV);
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(PEOPLE_CSV_FILENAME).toMatch(/\.csv$/);
  });
});
