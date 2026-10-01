/**
 * A spreadsheet download (team feedback, 1 Oct 2026: "make this exportable").
 *
 * CSV rather than a real .xlsx: Excel opens it with a double-click, so does
 * Google Sheets and Numbers, and it needs nothing on the server. The byte
 * order mark tells Excel the file is UTF-8, so names like "Ocho Ríos" and the
 * "–" in ranges come through intact.
 */
export function downloadCsv(name: string, rows: Array<Array<string | number | null | undefined>>): void {
  const cell = (c: string | number | null | undefined) => `"${String(c ?? '').replace(/"/g, '""')}"`;
  const csv = '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name.endsWith('.csv') ? name : `${name}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Cents as plain dollars for a spreadsheet cell: 123456 -> 1234.56. */
export const dollars = (c: number | string | null | undefined): string =>
  (c === null || c === undefined || c === '' ? '' : (Number(c) / 100).toFixed(2));
