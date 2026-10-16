/**
 * Reading a spreadsheet the office picks (the customer upload, 16 Oct 2026).
 *
 * A .csv, or the Excel file itself (.xlsx) - so the merged file can be
 * uploaded just as it was edited, Open Items sheet and all, without saving a
 * copy as CSV first. No library: an .xlsx is a zip of XML files, and the
 * browser can already unzip (DecompressionStream). Only what a plain data
 * sheet needs is read - cell values, not formatting or formulas' workings
 * (a formula's last worked-out value is what is stored in the file, and that
 * is what is used).
 */

export type Table = string[][];

/** Every sheet in the file, by name; a CSV is one sheet called "Sheet1". */
export async function readSheets(file: File): Promise<Record<string, Table>> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  if (isZip) return readXlsx(buf);
  if (/\.xls$/i.test(file.name)) {
    throw new Error('That is the old Excel format (.xls). Save it as .xlsx or .csv and choose it again.');
  }
  return { Sheet1: parseCsv(new TextDecoder('utf-8').decode(buf)) };
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

/** RFC 4180-ish: quoted fields, "" inside quotes, CRLF or LF, a BOM. */
export function parseCsv(text: string): Table {
  const s = text.replace(/^﻿/, '');
  // Excel in some regions saves with semicolons.
  const firstLine = s.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: Table = [];
  let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/* ------------------------------------------------------------------ */
/* XLSX                                                                */
/* ------------------------------------------------------------------ */

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The files inside a zip, by path. */
async function unzip(buf: Uint8Array): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('That file could not be opened as an Excel workbook.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + size);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, await inflate(raw));
  }
  return out;
}

const decodeXml = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

/** All the text in the <t> elements of an XML fragment (a shared string can be several runs). */
const textOf = (xml: string) =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map((m) => decodeXml(m[1] ?? '')).join('');

const colIndex = (ref: string) => {
  const letters = ref.replace(/[^A-Z]/gi, '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

export async function readXlsx(buf: Uint8Array): Promise<Record<string, Table>> {
  const files = await unzip(buf);
  const dec = new TextDecoder();
  const text = (path: string) => { const f = files.get(path); return f ? dec.decode(f) : ''; };

  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const rels = new Map<string, string>();
  for (const m of text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1];
    const target = m[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) rels.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }

  const out: Record<string, Table> = {};
  for (const m of text('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)) {
    const name = decodeXml(m[0].match(/\bname="([^"]*)"/)?.[1] ?? '');
    const rid = m[0].match(/\br:id="([^"]+)"/)?.[1] ?? '';
    const target = rels.get(rid);
    if (!target) continue;
    const xml = text(`xl/${target}`);
    const table: Table = [];
    for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const r = Number(row[1].match(/\br="(\d+)"/)?.[1] ?? table.length + 1) - 1;
      const cells: string[] = [];
      for (const c of row[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const ref = attrs.match(/\br="([A-Z]+)\d+"/i)?.[1] ?? '';
        const type = attrs.match(/\bt="([^"]+)"/)?.[1] ?? 'n';
        const body = c[2] ?? '';
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value = '';
        if (type === 's') value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') value = textOf(body);
        else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else value = v !== undefined ? decodeXml(v) : '';
        cells[ref ? colIndex(ref) : cells.length] = value;
      }
      table[r] = Array.from(cells, (x) => x ?? '');
    }
    out[name] = Array.from(table, (x) => x ?? []).filter((r) => r.some((c) => String(c).trim() !== ''));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Values                                                              */
/* ------------------------------------------------------------------ */

/** "4,357.26", "(3,000.00)", "-3000", "J$1,000", "-" -> cents. Blank -> 0. NaN when unreadable. */
export function centsFrom(text: string): number {
  let t = String(text ?? '').trim().replace(/J?\$|JMD|\s/gi, '').replace(/,/g, '');
  if (t === '' || t === '-' || t === '–') return 0;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (t.endsWith('-')) { neg = true; t = t.slice(0, -1); }
  const n = Number(t);
  if (!Number.isFinite(n)) return NaN;
  return Math.round((neg ? -n : n) * 100);
}

/** An Excel day number (46310) or a written date -> yyyy-mm-dd; '' when unreadable. */
export function isoFrom(text: string, dayFirst = true): string {
  const t = String(text ?? '').trim();
  if (!t) return '';
  if (/^\d+(\.\d+)?$/.test(t)) {
    const days = Math.floor(Number(t));
    if (days > 20000 && days < 80000) {
      return new Date(Date.UTC(1899, 11, 30) + days * 86400000).toISOString().slice(0, 10);
    }
    return '';
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const [d, mo] = dayFirst ? [m[1], m[2]] : [m[2], m[1]];
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const w = t.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-,]*(\d{4})$/);
  if (w) {
    const mo = months.indexOf(w[2].toLowerCase()) + 1;
    if (mo > 0) return `${w[3]}-${String(mo).padStart(2, '0')}-${w[1].padStart(2, '0')}`;
  }
  return '';
}

/** A header as a key: "Opening Balance (JMD)" -> "openingbalancejmd". */
export const headerKey = (h: string) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
