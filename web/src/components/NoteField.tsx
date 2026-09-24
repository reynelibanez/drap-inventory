import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Popover } from './grid/Popover';

export type NoteSuggestionField = 'notes' | 'cosmeticGradeNote' | 'functionalGradeNote';

/** Valores ya usados antes en ese campo de nota, para sugerir en vez de volver a escribir lo mismo. */
export function useNoteSuggestions(field: NoteSuggestionField) {
  return useQuery({
    queryKey: ['note-suggestions', field],
    queryFn: () => api.get<{ suggestions: string[] }>(`/units/note-suggestions?field=${field}`),
    staleTime: 60_000,
  });
}

/**
 * Área de texto para una nota (general o de un grado) con sugerencias de notas ya guardadas antes.
 * Al escribir o al enfocar el campo se muestra una lista con las que empiezan igual (o todas si está vacío);
 * al elegir una se reemplaza el contenido completo.
 */
export function NoteField({ field, value, onChange, disabled, rows = 2, placeholder }: {
  field: NoteSuggestionField; value: string; onChange: (v: string) => void; disabled?: boolean; rows?: number; placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const sug = useNoteSuggestions(field);

  const options = useMemo(() => {
    const all = sug.data?.suggestions ?? [];
    const q = value.trim().toLowerCase();
    const list = q ? all.filter((s) => s.toLowerCase().includes(q) && s.trim().toLowerCase() !== q) : all;
    return list.slice(0, 8);
  }, [sug.data, value]);

  return (
    <div className="note-field">
      <textarea
        ref={ref}
        className="input"
        rows={rows}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
      />
      {open && !disabled && options.length > 0 && (
        <Popover anchor={ref.current} onClose={() => setOpen(false)} minWidth={Math.max(220, ref.current?.offsetWidth ?? 0)}>
          <ul className="pop-list">
            {options.map((s, i) => (
              <li key={i}>
                <button
                  type="button"
                  className="note-suggestion-item"
                  onMouseDown={(e) => { e.preventDefault(); onChange(s); setOpen(false); }}
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>
        </Popover>
      )}
    </div>
  );
}
