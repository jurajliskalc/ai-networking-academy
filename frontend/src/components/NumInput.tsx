import { useEffect, useState, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max'> & {
  value: number;
  onValue: (v: number) => void;
  min: number;
  max?: number;
  /** Round to a whole number before applying. */
  integer?: boolean;
};

/**
 * A number field that lets the user type freely. Clamping on every keystroke made fields unusable:
 * clearing one snapped it to the minimum, so typing "1500" over "64" produced "641500" or "64". Here the
 * typed text is kept while editing, a value is applied as soon as it is valid and in range, and the field
 * is clamped to [min, max] only when it loses focus. Values set from outside (preset buttons) are shown.
 */
export default function NumInput({ value, onValue, min, max = Infinity, integer = false, onBlur, ...rest }: Props) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(String(value)); }, [value, editing]);

  const parse = (s: string) => {
    const t = s.trim();
    if (t === '') return null;
    const v = Number(t);
    return Number.isFinite(v) ? (integer ? Math.round(v) : v) : null;
  };

  return (
    <input {...rest} type="number" inputMode={integer ? 'numeric' : 'decimal'} min={min} max={Number.isFinite(max) ? max : undefined}
      value={editing ? draft : String(value)}
      onFocus={(e) => { setDraft(String(value)); setEditing(true); rest.onFocus?.(e); }}
      onChange={(e) => {
        setEditing(true);
        setDraft(e.target.value);
        const v = parse(e.target.value);
        if (v !== null && v >= min && v <= max && v !== value) onValue(v);
      }}
      onBlur={(e) => {
        const v = parse(draft);
        const c = v === null ? value : Math.min(max, Math.max(min, v));
        if (c !== value) onValue(c);
        setEditing(false);
        onBlur?.(e);
      }} />
  );
}
