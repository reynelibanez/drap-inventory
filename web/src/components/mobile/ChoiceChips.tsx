import type { ReactNode } from 'react';

export interface Choice { value: number; label: ReactNode; sub?: ReactNode; color?: string | null }

/**
 * Elección de una opción entre pocas (grados A/B/C/D…) con botones grandes en vez de una lista desplegable.
 * Tocar la opción elegida la deselecciona.
 */
export function ChoiceChips({ options, value, onChange, disabled, label }: {
  options: Choice[]; value: number | null | undefined; onChange: (v: number | null) => void; disabled?: boolean; label?: string;
}) {
  return (
    <div className="choice-chips" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} disabled={disabled} className={`choice ${on ? 'on' : ''}`}
            style={on && o.color ? { background: `${o.color}22`, borderColor: o.color, color: o.color } : undefined}
            onClick={() => onChange(on ? null : o.value)}>
            <b>{o.label}</b>{o.sub && <small>{o.sub}</small>}
          </button>
        );
      })}
    </div>
  );
}
