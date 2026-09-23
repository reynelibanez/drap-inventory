-- =====================================================================
-- 018_lot_bulk_and_documents.sql
-- (a) Un lote puede marcarse como que no requiere testeo individual: en ese caso sus equipos pueden
--     pasar directo a disponibles (sin pasar por testeo) para venderse sueltos o el lote completo.
-- (c) Las plantillas de etiqueta/documento ahora también pueden ser de "lote" (documento genérico
--     asociable a testeo/equipo, lote o pedido, con el mismo diseñador visual).
-- =====================================================================

ALTER TABLE lots ADD COLUMN requires_testing boolean NOT NULL DEFAULT true;

ALTER TABLE label_templates DROP CONSTRAINT label_templates_kind_check;
ALTER TABLE label_templates ADD CONSTRAINT label_templates_kind_check CHECK (kind IN ('unit', 'order', 'lot'));
