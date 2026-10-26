import { centsFrom, headerKey, type Table } from './sheetfile';

/*
 * Reading the "Products & Prices" workbook (25 Oct 2026), made from the
 * QuickBooks Product/Service list. Columns are found by heading, in any
 * order. The tier columns are any heading that names a price tier
 * (Retail, Corporate, Wholesale, Distributor) - so a tier added later needs
 * no change here. Prices exclude GCT.
 */

export interface ProductUploadRow {
  name: string; brand: string; bottledFor: string; size: string;
  bottlesPerCase: string; returnable: string; bottleCharge: string;
  listPriceCents: number | null;
  tierPrices: Record<string, number | null>;
}
export interface SpecialUploadRow { customer: string; product: string; priceCents: number | null }
export interface ProductReadResult {
  products: ProductUploadRow[];
  specials: SpecialUploadRow[];
  tierColumns: string[];
  problems: string[];
}

const FIXED: Record<string, keyof ProductUploadRow | 'skip'> = {
  productname: 'name', product: 'name', name: 'name',
  brand: 'brand',
  bottledfor: 'bottledFor', client: 'bottledFor', bottlingclient: 'bottledFor',
  size: 'size',
  bottlespercase: 'bottlesPerCase', percase: 'bottlesPerCase',
  returnable5gallon: 'returnable', returnable: 'returnable',
  bottlecharge: 'bottleCharge',
  listpricejmdexgct: 'listPriceCents', listpricejmd: 'listPriceCents', listprice: 'listPriceCents',
  quickbooksitem: 'skip', quickbooksitems: 'skip', notes: 'skip', note: 'skip',
};
const TIER_WORDS = ['retail', 'corporate', 'wholesale', 'distributor'];
const norm = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim();

function headerRow(t: Table, test: (keys: string[]) => boolean): number {
  for (let i = 0; i < Math.min(t.length, 10); i++) if (test(t[i].map(headerKey))) return i;
  return -1;
}

export function readProductUpload(sheets: Record<string, Table>): ProductReadResult {
  const problems: string[] = [];
  const names = Object.keys(sheets);
  const pName = names.find((n) => headerKey(n) === 'products')
    ?? names.find((n) => headerRow(sheets[n], (k) => k.includes('productname')) >= 0);
  if (!pName) {
    return { products: [], specials: [], tierColumns: [], problems: ['No "Products" sheet with a "Product Name" column was found.'] };
  }
  const pt = sheets[pName];
  const ph = headerRow(pt, (k) => k.includes('productname'));
  const heads = pt[ph].map(headerKey);
  const raw = pt[ph].map(norm);
  const tierCols = heads.map((k, i) => (TIER_WORDS.some((w) => k.startsWith(w)) ? i : -1)).filter((i) => i >= 0);
  const tierName = (i: number) => raw[i].replace(/\s*\(.*\)\s*$/, '').trim();
  const at = (row: string[], field: keyof ProductUploadRow) => {
    const i = heads.findIndex((k) => FIXED[k] === field);
    return i < 0 ? '' : norm(row[i] ?? '');
  };
  const money = (text: string, where: string) => {
    if (!text) return null;
    const c = centsFrom(text);
    if (!Number.isFinite(c)) { problems.push(`${where}: "${text}" is not a price.`); return null; }
    return c;
  };

  const products: ProductUploadRow[] = [];
  for (const [i, row] of pt.slice(ph + 1).entries()) {
    const name = at(row, 'name');
    if (!name) continue;
    const where = `Products row ${ph + i + 2} (${name})`;
    const tierPrices: Record<string, number | null> = {};
    for (const c of tierCols) tierPrices[tierName(c)] = money(norm(row[c] ?? ''), where);
    products.push({
      name, brand: at(row, 'brand'), bottledFor: at(row, 'bottledFor'), size: at(row, 'size'),
      bottlesPerCase: at(row, 'bottlesPerCase') || '0', returnable: at(row, 'returnable'),
      bottleCharge: at(row, 'bottleCharge'), listPriceCents: money(at(row, 'listPriceCents'), where), tierPrices,
    });
  }
  if (products.length === 0) problems.push('There are no products under the headings.');

  const specials: SpecialUploadRow[] = [];
  const sName = names.find((n) => headerKey(n) === 'specialprices');
  if (sName) {
    const st = sheets[sName];
    const sh = headerRow(st, (k) => k.includes('customername') && k.includes('productname'));
    if (sh < 0) problems.push('The Special Prices sheet needs "Customer Name", "Product Name" and "Price" headings.');
    else {
      const sk = st[sh].map(headerKey);
      const col = (row: string[], ...keys: string[]) => {
        const i = sk.findIndex((k) => keys.some((w) => k === w || k.startsWith(w)));
        return i < 0 ? '' : norm(row[i] ?? '');
      };
      for (const [i, row] of st.slice(sh + 1).entries()) {
        const customer = col(row, 'customername');
        if (!customer) continue;
        specials.push({
          customer, product: col(row, 'productname'),
          priceCents: money(col(row, 'price'), `Special Prices row ${sh + i + 2} (${customer})`),
        });
      }
    }
  }
  return { products, specials, tierColumns: tierCols.map(tierName), problems };
}
