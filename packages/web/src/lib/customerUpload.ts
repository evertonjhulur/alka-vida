/**
 * The customer upload file, read into the rows POST /api/customers/import
 * takes (16 Oct 2026). Kept apart from the screen so it can be tested.
 *
 * The columns are found by their headings, in any order, so a column added,
 * moved or deleted in Excel does not matter; only "Customer Name" is needed.
 * The sheet used is "Customer Upload" when there is one, else the first
 * sheet with a Customer Name heading. An "Open Items" sheet (the Excel file)
 * gives each customer's open QuickBooks invoices and unapplied payments.
 */

import { centsFrom, headerKey, isoFrom, type Table } from './sheetfile.ts';

export interface OpenItem {
  reference: string | null; type: string | null; date: string | null; dueDate: string | null;
  amountCents: number | null; openCents: number;
}
export interface UploadRow {
  name: string; customerType: string; contactPerson: string; phone: string; mobile: string; email: string;
  billingAddress: string; deliveryAddress: string; area: string; parish: string;
  deliveryZone: string; deliveryDays: string; openingBalanceCents: number;
  bottledBrands: string; canOrderOwnBrand: string; openItems: OpenItem[];
}
export interface ReadResult {
  sheet: string;
  rows: UploadRow[];
  /** Problems with the file itself (not with a customer), shown before anything is sent. */
  problems: string[];
  /** The "as of" date in the file, if it has one. */
  asOf: string | null;
  /** How many customers had open items from the Open Items sheet. */
  withItems: number;
  /** Headings that were not recognised (ignored). */
  ignored: string[];
}

/** Heading (as a key) -> field. Several spellings for the ones people retype. */
const COLUMNS: Record<string, keyof UploadRow | 'asOf' | 'skip'> = {
  customername: 'name', name: 'name', customerfullname: 'name', customer: 'name',
  customertype: 'customerType', type: 'customerType',
  contactperson: 'contactPerson', contact: 'contactPerson', fullname: 'contactPerson',
  phone: 'phone', phonenumbers: 'phone', telephone: 'phone',
  mobile: 'mobile', cell: 'mobile',
  email: 'email', emailaddress: 'email',
  billingaddress: 'billingAddress', billaddress: 'billingAddress',
  deliveryaddress: 'deliveryAddress', shipaddress: 'deliveryAddress', address: 'deliveryAddress',
  area: 'area', town: 'area', city: 'area',
  parish: 'parish',
  deliveryzone: 'deliveryZone', zone: 'deliveryZone',
  deliverydays: 'deliveryDays', deliveryday: 'deliveryDays', days: 'deliveryDays',
  openingbalancejmd: 'openingBalanceCents', openingbalance: 'openingBalanceCents', balance: 'openingBalanceCents',
  openbalance: 'openingBalanceCents',
  balanceasof: 'asOf',
  bottledbrands: 'bottledBrands', brands: 'bottledBrands',
  canorderalkavidaproducts: 'canOrderOwnBrand', alkavidaproducts: 'canOrderOwnBrand',
  // The reference columns in the merged file; read past without complaint.
  zonebasis: 'skip', suggestedtype: 'skip', suggestedzone: 'skip',
};

const norm = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim();
const nameKey = (s: string) => norm(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function findHeader(t: Table, wanted: (keys: string[]) => boolean): number {
  for (let i = 0; i < Math.min(t.length, 15); i++) {
    if (wanted(t[i].map(headerKey))) return i;
  }
  return -1;
}

export function readUpload(sheets: Record<string, Table>): ReadResult {
  const problems: string[] = [];
  const names = Object.keys(sheets);
  const hasName = (keys: string[]) => keys.some((k) => COLUMNS[k] === 'name');
  const sheet = names.find((n) => headerKey(n) === 'customerupload')
    ?? names.find((n) => findHeader(sheets[n], hasName) >= 0) ?? names[0];
  const table = sheets[sheet] ?? [];
  const h = findHeader(table, hasName);
  if (h < 0) {
    return { sheet, rows: [], asOf: null, withItems: 0, ignored: [],
      problems: ['No "Customer Name" column was found. Is this the customer upload file?'] };
  }

  const heads = table[h].map(headerKey);
  const ignored: string[] = [];
  heads.forEach((k, i) => { if (k && !COLUMNS[k]) ignored.push(norm(table[h][i])); });
  const at = (row: string[], field: string) => {
    const i = heads.findIndex((k) => COLUMNS[k] === field);
    return i < 0 ? '' : norm(row[i] ?? '');
  };

  // Open Items: by customer name.
  const items = new Map<string, OpenItem[]>();
  const oiName = names.find((n) => headerKey(n) === 'openitems');
  if (oiName) {
    const ot = sheets[oiName];
    const oh = findHeader(ot, (keys) => keys.includes('customername') && keys.some((k) => k.startsWith('openbalance')));
    if (oh >= 0) {
      const ok = ot[oh].map(headerKey);
      const col = (row: string[], ...keys: string[]) => {
        const i = ok.findIndex((k) => keys.some((w) => k === w || k.startsWith(w)));
        return i < 0 ? '' : norm(row[i] ?? '');
      };
      for (const row of ot.slice(oh + 1)) {
        const who = col(row, 'customername');
        if (!who || /^total$/i.test(who)) continue;
        const open = centsFrom(col(row, 'openbalance'));
        if (!Number.isFinite(open) || open === 0) continue;
        const amount = centsFrom(col(row, 'amount'));
        const list = items.get(nameKey(who)) ?? [];
        list.push({
          reference: col(row, 'number') || null, type: col(row, 'type') || null,
          date: isoFrom(col(row, 'date')) || null, dueDate: isoFrom(col(row, 'duedate')) || null,
          amountCents: Number.isFinite(amount) ? amount : null, openCents: open,
        });
        items.set(nameKey(who), list);
      }
    } else problems.push('The Open Items sheet has no "Customer Name" and "Open Balance" headings; it was not used.');
  }

  let asOf: string | null = null;
  let withItems = 0;
  const rows: UploadRow[] = [];
  for (const [i, row] of table.slice(h + 1).entries()) {
    const name = at(row, 'name');
    if (!name || /^total$/i.test(name)) continue;
    const balText = at(row, 'openingBalanceCents');
    const bal = centsFrom(balText);
    if (!Number.isFinite(bal)) problems.push(`Row ${h + i + 2} (${name}): the opening balance "${balText}" is not a number.`);
    asOf = asOf ?? (isoFrom(at(row, 'asOf')) || null);
    const own = items.get(nameKey(name)) ?? [];
    if (own.length) withItems++;
    rows.push({
      name,
      customerType: at(row, 'customerType'), contactPerson: at(row, 'contactPerson'),
      phone: at(row, 'phone'), mobile: at(row, 'mobile'), email: at(row, 'email'),
      billingAddress: at(row, 'billingAddress'), deliveryAddress: at(row, 'deliveryAddress'),
      area: at(row, 'area'), parish: at(row, 'parish'),
      deliveryZone: at(row, 'deliveryZone'), deliveryDays: at(row, 'deliveryDays'),
      openingBalanceCents: Number.isFinite(bal) ? bal : 0,
      bottledBrands: at(row, 'bottledBrands'), canOrderOwnBrand: at(row, 'canOrderOwnBrand'),
      openItems: own,
    });
  }
  if (rows.length === 0) problems.push('There are no customers under the headings.');
  return { sheet, rows, problems, asOf, withItems, ignored };
}
