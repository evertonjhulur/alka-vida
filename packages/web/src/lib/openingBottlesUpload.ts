import { headerKey, isoFrom, type Table } from './sheetfile';

/*
 * Reading the opening-bottles workbook (28 Oct 2026): one row per customer
 * with the number of OUR 5-gallon bottles they hold. Any sheet with a
 * customer column and a bottles column will do, found by heading:
 *   customer:  "Customer Name", "Customer", "App account"
 *   bottles:   "Our Bottles", "Ours on loan", "Our bottles with them", "Bottles"
 *   as at:     an optional "As At" column (the first date found is used)
 * Other columns (notes, sheet names) are ignored.
 */

export interface OpeningUploadRow { customer: string; quantity: string }
export interface OpeningReadResult { rows: OpeningUploadRow[]; asOf: string; sheet: string; problems: string[] }

const CUSTOMER = ['customername', 'customer', 'appaccount', 'appaccountname'];
const BOTTLES = ['ourbottles', 'oursonloan', 'ourbottleswiththem', 'ourbottlesonloan', 'bottles', 'openingbottles'];
const AS_AT = ['asat', 'asof', 'asatdate', 'asofdate'];

export function readOpeningBottles(sheets: Record<string, Table>): OpeningReadResult {
  for (const [name, t] of Object.entries(sheets)) {
    for (let h = 0; h < Math.min(t.length, 10); h++) {
      const keys = t[h].map(headerKey);
      const ci = keys.findIndex((k) => CUSTOMER.includes(k));
      const bi = keys.findIndex((k) => BOTTLES.includes(k));
      if (ci < 0 || bi < 0) continue;
      const ai = keys.findIndex((k) => AS_AT.includes(k));
      const rows: OpeningUploadRow[] = [];
      let asOf = '';
      for (const r of t.slice(h + 1)) {
        const customer = String(r[ci] ?? '').replace(/\s+/g, ' ').trim();
        if (!customer || /^total\b/i.test(customer)) continue;
        rows.push({ customer, quantity: String(r[bi] ?? '').trim() });
        if (!asOf && ai >= 0) asOf = isoFrom(String(r[ai] ?? ''));
      }
      const problems = rows.length ? [] : [`The "${name}" sheet has no customers under its headings.`];
      return { rows, asOf, sheet: name, problems };
    }
  }
  return { rows: [], asOf: '', sheet: '', problems: ['No sheet with a "Customer Name" column and an "Our Bottles" column was found.'] };
}
