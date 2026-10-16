import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The same three tools on every list (Everton, 11 Oct 2026):
 *
 *   - a Status drop-down, like the one on a customer's statement;
 *   - sorting by any column heading (click once A-Z / oldest / smallest
 *     first, again for the other way);
 *   - tick boxes and a "Batch actions" menu, as QuickBooks has on its
 *     invoice list, for doing one thing to several rows at once.
 *
 * Plain components and hooks at module level (never declared inside a page:
 * see HANDOFF, "Never declare a React component inside another component").
 */

/* ---------------- status drop-down ---------------- */

export function StatusSelect({
  id, value, onChange, options, label = 'Status',
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  /** [value, words]; the first is usually ['', 'Any status']. */
  options: ReadonlyArray<readonly [string, string]>;
  label?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, words]) => <option key={v} value={v}>{words}</option>)}
      </select>
    </div>
  );
}

/**
 * The status drop-down with several ticked at once (Everton, 15 Oct 2026:
 * "multiselect for the status dropdowns in all the status fields").
 *
 * `value` is the list ticked; an empty list means any status. The options
 * are the same [value, words] pairs as StatusSelect's; one whose value is ''
 * (or 'all') is the "Any status" choice, which clears the ticks.
 */
export function MultiStatusSelect({
  id, value, onChange, options, label = 'Status', anyLabel,
}: {
  id: string;
  value: readonly string[];
  onChange: (v: string[]) => void;
  options: ReadonlyArray<readonly [string, string]>;
  label?: string;
  anyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const anyOpt = options.find(([v]) => v === '' || v === 'all');
  const any = anyLabel ?? anyOpt?.[1] ?? 'Any status';
  const choices = options.filter(([v]) => v !== '' && v !== 'all');
  const picked = choices.filter(([v]) => value.includes(v));
  const words = (w: string) => w.replace(/^[·\s]+/, '');
  const summary = picked.length === 0 ? any
    : picked.length <= 2 ? picked.map(([, w]) => words(w)).join(', ')
      : `${picked.length} chosen`;
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  return (
    <div className="field multi-select" ref={box}>
      <label htmlFor={id}>{label}</label>
      <button id={id} type="button" className="multi-select-btn" aria-haspopup="true" aria-expanded={open}
              title={picked.map(([, w]) => words(w)).join(', ') || any}
              onClick={() => setOpen(!open)}>
        <span>{summary}</span><span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="deskbar-pop multi-select-pop" role="group" aria-label={label}>
          <label className="multi-select-item any">
            <input type="checkbox" checked={value.length === 0} onChange={() => onChange([])} />
            <span>{any}</span>
          </label>
          {choices.map(([v, w]) => (
            <label key={v} className={`multi-select-item${w.startsWith('·') ? ' sub' : ''}`}>
              <input type="checkbox" checked={value.includes(v)} onChange={() => toggle(v)} />
              <span>{words(w)}</span>
            </label>
          ))}
          {value.length > 0 && (
            <div className="multi-select-foot">
              <button type="button" className="as-link small" onClick={() => onChange([])}>Clear</button>
              <button type="button" className="as-link small" onClick={() => setOpen(false)}>Done</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** True when a row passes a multi-status filter: nothing ticked, or any one ticked matches. */
export function passes(ticked: readonly string[], matches: (v: string) => boolean): boolean {
  return ticked.length === 0 || ticked.some(matches);
}

/* ---------------- sorting by heading ---------------- */

export type SortDir = 'asc' | 'desc';
export interface SortState { key: string; dir: SortDir }
type Value = string | number | boolean | null | undefined;

/** Numbers as numbers, words and invoice numbers in natural order, blanks last. */
function compare(a: Value, b: Value): number {
  const blank = (v: Value) => v === null || v === undefined || v === '';
  if (blank(a) && blank(b)) return 0;
  if (blank(a)) return 1;
  if (blank(b)) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

/**
 * Rows sorted by the heading clicked. `values` says what each column sorts
 * on (a date as yyyy-mm-dd, money as a number of cents). Until a heading is
 * clicked the rows keep the order they came in.
 */
export function useSort<T>(
  rows: readonly T[],
  values: Record<string, (row: T) => Value>,
  initial: SortState | null = null,
) {
  const [sort, setSort] = useState<SortState | null>(initial);
  const by = sort ? values[sort.key] : undefined;
  const sorted = by
    ? rows.map((r, i) => ({ r, i }))
      .sort((x, y) => {
        const c = compare(by(x.r), by(y.r));
        if (c !== 0) {
          // Blanks stay at the bottom whichever way round.
          const blank = by(x.r) === null || by(x.r) === undefined || by(x.r) === ''
            || by(y.r) === null || by(y.r) === undefined || by(y.r) === '';
          return sort!.dir === 'asc' || blank ? c : -c;
        }
        return x.i - y.i;
      })
      .map((x) => x.r)
    : [...rows];
  const onSort = (key: string) => setSort((cur) => (cur?.key === key
    ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  return { sorted, sort, onSort };
}

/** A column heading that sorts the list when clicked. */
export function SortTh({
  label, k, sort, onSort, className,
}: {
  label: ReactNode; k: string; sort: SortState | null; onSort: (k: string) => void; className?: string;
}) {
  const on = sort?.key === k;
  return (
    <th className={className} aria-sort={on ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className={`th-sort${on ? ' on' : ''}`} onClick={() => onSort(k)}
              title={on ? (sort!.dir === 'asc' ? 'Sorted A to Z, lowest first. Click to reverse.' : 'Sorted Z to A, highest first. Click to reverse.')
                : 'Sort by this column'}>
        <span>{label}</span>
        <span className="th-arrow" aria-hidden="true">{on ? (sort!.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>
      </button>
    </th>
  );
}

/* ---------------- tick boxes ---------------- */

/** Which rows are ticked. Rows that leave the list (a filter) are unticked. */
export function useTicks(shownIds: readonly string[]) {
  const [picked, setPicked] = useState<string[]>([]);
  const key = shownIds.join('|');
  useEffect(() => {
    setPicked((cur) => {
      const next = cur.filter((id) => shownIds.includes(id));
      return next.length === cur.length ? cur : next;
    });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = shownIds.length > 0 && shownIds.every((id) => picked.includes(id));
  return {
    picked,
    has: (id: string) => picked.includes(id),
    toggle: (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])),
    toggleAll: () => setPicked(all ? [] : [...shownIds]),
    clear: () => setPicked([]),
    all,
    some: picked.length > 0 && !all,
  };
}

/** The tick-everything box at the head of the tick column. */
export function TickAllTh({ all, some, onToggle, disabled }: {
  all: boolean; some: boolean; onToggle: () => void; disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = some; }, [some]);
  return (
    <th className="tick-col">
      <input ref={ref} type="checkbox" aria-label="Tick every row shown" checked={all}
             disabled={disabled} onChange={onToggle} />
    </th>
  );
}

export function TickTd({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) {
  return (
    <td className="tick-col">
      <input type="checkbox" aria-label={label} checked={checked} onChange={onToggle} />
    </td>
  );
}

/* ---------------- the Batch actions menu ---------------- */

export interface BatchAction {
  label: string;
  run: () => void;
  /** Red, for anything that cancels or removes. */
  danger?: boolean;
  /** Greyed out, with the reason as its hint. */
  disabledWhy?: string | null;
}

/**
 * "Batch actions ▾" with what is ticked beside it. The menu opens under the
 * button; actions that cannot apply to what is ticked are greyed with why.
 */
export function BatchBar({
  count, noun, summary, actions, onClear, busy, inset,
}: {
  count: number;
  noun: [string, string];
  summary?: ReactNode;
  actions: BatchAction[];
  onClear: () => void;
  busy?: boolean;
  /** Inside a panel with no padding (lists edge to edge): padded, ruled below. */
  inset?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  useEffect(() => { if (count === 0) setOpen(false); }, [count]);

  return (
    <div className={`batch-tools${inset ? ' inset' : ''}`}>
      <div className="batch-menu" ref={box}>
        <button type="button" className="secondary" aria-haspopup="true" aria-expanded={open}
                disabled={count === 0 || busy} onClick={() => setOpen(!open)}>
          {busy ? 'Working…' : 'Batch actions'} <span aria-hidden="true">▾</span>
        </button>
        {open && (
          <div className="deskbar-pop batch-pop" role="menu">
            {actions.map((a) => (
              <button key={a.label} type="button" role="menuitem"
                      className={`pop-item pop-button${a.danger ? ' pop-danger' : ''}`}
                      disabled={!!a.disabledWhy} title={a.disabledWhy ?? undefined}
                      onClick={() => { setOpen(false); a.run(); }}>
                <span>{a.label}</span>
                {a.disabledWhy && <span className="pop-meta">{a.disabledWhy}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <span className="batch-count">
        {count === 0 ? `Tick ${noun[1]} to act on several at once`
          : <>{count} {count === 1 ? noun[0] : noun[1]} ticked{summary ? <> · {summary}</> : null}</>}
      </span>
      {count > 0 && <button type="button" className="as-link small" onClick={onClear}>Clear</button>}
    </div>
  );
}

/** "Sent to 3 customers; 1 could not go: ..." from a batch send's results. */
export function sendSummary(results: Array<{ label: string; sentTo?: string; error?: string }>): {
  ok: string | null; problems: string[];
} {
  const sent = results.filter((r) => r.sentTo);
  const bad = results.filter((r) => r.error);
  return {
    ok: sent.length ? `Sent: ${sent.map((r) => `${r.label} (${r.sentTo})`).join('; ')}.` : null,
    problems: bad.map((r) => `${r.label}: ${r.error}`),
  };
}
