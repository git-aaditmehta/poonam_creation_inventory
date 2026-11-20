import React, { useEffect, useState } from 'react';
import { Gem, Plus, X, CheckCircle2, Loader2 } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../context/ToastContext';
import { errorText } from '../utils/friendlyErrors';
import { setJewelryTypes, typeLabel, useJewelryTypes } from '../utils/jewelryCategory';

/**
 * Jewelry types (agreed 2026-11-21), shown in Materials & Categories under the costing categories but separate from
 * them: these only group designs in Plated / Raw Jewelry and Scan by the letters their code starts with. The owner
 * can add a type; it appears everywhere (all phones) and existing designs with those letters move under it.
 */
export const JewelryTypesCard: React.FC = () => {
  const { showToast } = useToast();
  const types = useJewelryTypes();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  // Show the latest list when this screen opens
  useEffect(() => {
    if (navigator.onLine) api.jewelryTypes.list().then((r) => setJewelryTypes(r.types)).catch(() => undefined);
  }, []);

  const p = prefix.trim().toUpperCase();
  const n = name.trim().replace(/\s+/g, ' ');
  const problem = !n
    ? null
    : n.length > 40
      ? 'The name is too long (at most 40 characters).'
      : types.some((t) => t.name.toLowerCase() === n.toLowerCase())
        ? `"${n}" already exists.`
        : !p
          ? null
          : !/^[A-Z]{1,5}$/.test(p)
            ? 'Letters only (A–Z), 1 to 5 of them, no numbers, spaces or symbols.'
            : types.some((t) => t.prefix === p)
              ? `${p} is already used by "${types.find((t) => t.prefix === p)!.name}".`
              : null;

  const save = async () => {
    if (!n || !p || problem) return;
    if (!navigator.onLine) {
      showToast('warning', 'No internet', 'Adding a jewelry type needs internet so every phone gets it.');
      return;
    }
    setSaving(true);
    try {
      const res = await api.jewelryTypes.add(n, p);
      setJewelryTypes(res.types);
      const moved = res.existing.plated + res.existing.raw;
      const msg = moved
        ? `${typeLabel(res.added)} added. ${res.existing.plated} plated and ${res.existing.raw} raw designs already start with ${p} and now appear under it.`
        : `${typeLabel(res.added)} added. Designs whose code starts with ${p} (e.g. ${p} 101) will appear under it.`;
      setDone(msg);
      showToast('success', 'Jewelry type added', msg);
      setName('');
      setPrefix('');
      setOpen(false);
    } catch (err) {
      showToast('error', 'Not added', errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ padding: 16, border: '1px solid var(--border-medium)', marginTop: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--teal-deep)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          <Gem size={15} /> Jewelry types
        </span>
        {!open && (
          <button type="button" className="btn btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 13 }} onClick={() => { setOpen(true); setDone(null); }}>
            <Plus size={14} /> Add jewelry type
          </button>
        )}
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 10px' }}>
        Used only to group designs in Plated Jewelry, Raw Jewelry and Scan, by the letters their code starts with (e.g. NK 101 → Necklace set).
        Not the same as the costing categories above.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {types.map((t) => (
          <span key={t.prefix} className="badge" style={{ fontSize: 12, padding: '4px 10px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-medium)', color: 'var(--text-primary)' }}>
            {t.name} <strong style={{ color: 'var(--teal-deep)' }}>({t.prefix})</strong>
          </span>
        ))}
      </div>

      {done && !open && (
        <div style={{ display: 'flex', gap: 6, marginTop: 10, fontSize: 12, color: 'var(--emerald-text)' }}>
          <CheckCircle2 size={14} style={{ flexShrink: 0, marginTop: 1 }} /> {done}
        </div>
      )}

      {open && (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 'var(--radius-md)', background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 600, flex: '1 1 180px' }}>
              Name
              <input className="input" placeholder="e.g. Choker" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 600, flex: '0 1 120px' }}>
              Code letters
              <input className="input mono" placeholder="e.g. CH" value={prefix} maxLength={5} onChange={(e) => setPrefix(e.target.value.toUpperCase())} autoCapitalize="characters" />
            </label>
            <button type="button" className="btn btn-primary" disabled={!n || !p || !!problem || saving} onClick={save} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => { setOpen(false); setName(''); setPrefix(''); }} aria-label="Cancel">
              <X size={14} />
            </button>
          </div>
          <div style={{ fontSize: 12, marginTop: 8, color: problem ? '#B91C1C' : 'var(--text-secondary)' }}>
            {problem ||
              (n && p
                ? `Designs whose code starts with ${p} (e.g. ${p} 101) will appear under "${n}" in Plated, Raw and Scan, on every phone.`
                : 'Type a name and the letters its design codes start with. Types can be added but not removed, so check the letters first.')}
          </div>
        </div>
      )}
    </div>
  );
};
