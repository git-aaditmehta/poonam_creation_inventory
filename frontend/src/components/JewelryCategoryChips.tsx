import React from 'react';
import { JEWELRY_CATEGORY_CHIPS, type JewelryCategory } from '../utils/jewelryCategory';

interface Props {
  value: JewelryCategory | null;
  onChange: (value: JewelryCategory | null) => void;
  /** Counts per category key plus `all`; missing counts are simply not shown. */
  counts?: Record<string, number> | null;
}

/** Jewelry-type filter chips (All / Earring / Stud / Jhumka / Bracelet / Pendant set / Other). */
export const JewelryCategoryChips: React.FC<Props> = ({ value, onChange, counts }) => (
  <div className="jc-chips" role="radiogroup" aria-label="Filter by jewelry type">
    {JEWELRY_CATEGORY_CHIPS.map((c) => {
      const n = counts ? counts[c.value ?? 'all'] ?? 0 : null;
      // "Other" only appears when something is in it, so no item can ever be hidden, without extra clutter
      if (c.value === 'other' && n === 0 && value !== 'other') return null;
      const active = value === c.value;
      return (
        <button
          key={c.label}
          type="button"
          role="radio"
          aria-checked={active}
          className={`jc-chip ${active ? 'active' : ''}`}
          onClick={() => onChange(c.value)}
        >
          {c.label}
          {n !== null && <span className="jc-count">{n}</span>}
        </button>
      );
    })}
    <style>{`
      .jc-chips { display: flex; gap: 6px; overflow-x: auto; padding: 2px 0 6px; margin-bottom: 10px; -webkit-overflow-scrolling: touch; scrollbar-width: thin; }
      .jc-chip { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; min-height: 36px; border-radius: 999px; border: 1px solid var(--border-medium); background: var(--bg-surface-1); color: var(--text-primary); font-size: 13px; font-weight: 500; cursor: pointer; white-space: nowrap; }
      .jc-chip.active { background: var(--teal-deep); color: #fff; border-color: var(--teal-deep); }
      .jc-count { font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 999px; background: var(--bg-surface-2); color: var(--text-secondary); }
      .jc-chip.active .jc-count { background: rgba(255,255,255,.22); color: #fff; }
    `}</style>
  </div>
);
