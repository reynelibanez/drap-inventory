import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { useDoc } from './docLang';
import { useMeta } from './meta';
import type { LabelCtx, LabelTemplate } from './labels';

export function useLabelTemplates(enabled = true) {
  return useQuery({
    queryKey: ['label-templates'],
    queryFn: () => api.get<{ items: LabelTemplate[] }>('/label-templates'),
    select: (d) => d.items,
    enabled,
  });
}

/**
 * Contexto para dibujar etiquetas: catálogos/atributos, textos y nombre de la empresa.
 * Una etiqueta es un documento y sale en el idioma de la empresa (`'doc'`); `'ui'` son los nombres de los campos tal como
 * los ve en pantalla quien diseña la plantilla.
 */
export function useLabelCtx(mode: 'doc' | 'ui' = 'doc'): LabelCtx {
  const meta = useMeta();
  const doc = useDoc();
  const { t, i18n } = useTranslation();
  return useMemo(() => (mode === 'doc'
    ? { meta: doc.meta, t: (k: string) => doc.t(k), company: meta.data.company.name }
    : { meta, t: (k: string) => t(k), company: meta.data.company.name }),
  [mode, meta, doc, t, i18n.language]);
}
