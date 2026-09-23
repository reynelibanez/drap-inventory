-- =====================================================================
-- 020_processor_generation_no_prefix.sql
-- El catálogo "Generaciones de procesador" guardaba el número completo de
-- la BIOS (p. ej. "i5-8350U"), repitiendo la familia que ya se elige en el
-- campo "Procesador" (Intel Core i5). De ahora en más solo guarda el
-- número de modelo (p. ej. "8350U"). Esto solo afecta a las empresas que
-- ya tenían el catálogo cargado antes de este cambio (las nuevas ya lo
-- reciben sin el prefijo, ver seed/processorData.ts).
-- =====================================================================

UPDATE catalog_items ci
SET name = jsonb_build_object(
  'es', regexp_replace(ci.name ->> 'es', '^i[3579]-', '', 'i'),
  'en', regexp_replace(ci.name ->> 'en', '^i[3579]-', '', 'i')
)
FROM catalogs c
WHERE ci.catalog_id = c.id
  AND c.key = 'processor_generation'
  AND (ci.name ->> 'es' ~* '^i[3579]-' OR ci.name ->> 'en' ~* '^i[3579]-');
