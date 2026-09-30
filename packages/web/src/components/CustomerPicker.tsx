import { useEffect, useRef, useState } from 'react';

export interface PickerCustomer {
  id: string; name: string; phone?: string | null; delivery_zone?: string | null;
}

/**
 * Type a name or phone number, pick from the list. Enter takes the first
 * match, Escape closes it. Replaces the long drop-down of every customer.
 */
export default function CustomerPicker({
  id, customers, value, onChange, placeholder,
}: {
  id: string;
  customers: PickerCustomer[];
  value: string;
  onChange: (customerId: string) => void;
  placeholder?: string;
}) {
  const chosen = customers.find((c) => c.id === value);
  const [text, setText] = useState(chosen?.name ?? '');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => { setText(chosen?.name ?? ''); }, [chosen?.id]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) {
        setOpen(false);
        setText(chosen?.name ?? '');
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, chosen]);

  const needle = text.trim().toLowerCase();
  const digits = needle.replace(/\D/g, '');
  const matches = customers
    .filter((c) => !needle || c.name.toLowerCase().includes(needle)
      || (digits.length >= 3 && (c.phone ?? '').replace(/\D/g, '').includes(digits)))
    .slice(0, 8);

  const pick = (c: PickerCustomer) => { onChange(c.id); setText(c.name); setOpen(false); };

  return (
    <div className="combo" ref={box}>
      <input id={id} role="combobox" autoComplete="off" required
             aria-expanded={open} aria-controls={`${id}-list`}
             placeholder={placeholder ?? 'Start typing a name or phone number'}
             value={text}
             onFocus={(e) => { setOpen(true); e.currentTarget.select(); }}
             onChange={(e) => { setText(e.target.value); setOpen(true); }}
             onKeyDown={(e) => {
               if (e.key === 'Enter' && open && matches[0]) { e.preventDefault(); pick(matches[0]); }
               if (e.key === 'Escape') setOpen(false);
             }} />
      {open && (
        <div id={`${id}-list`} className="deskbar-pop combo-list" role="listbox">
          {matches.map((c) => (
            <button key={c.id} type="button" role="option" aria-selected={c.id === value}
                    className="pop-item pop-button" onClick={() => pick(c)}>
              <span>{c.name}</span>
              <span className="pop-meta">
                {[c.delivery_zone ? `${c.delivery_zone} zone` : null, c.phone].filter(Boolean).join(' · ')}
              </span>
            </button>
          ))}
          {matches.length === 0 && <div className="pop-empty">No customer called that.</div>}
        </div>
      )}
    </div>
  );
}
