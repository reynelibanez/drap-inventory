-- =====================================================================
-- 011_order_labels.sql
-- Etiquetas para documentos: además de las etiquetas de equipo (por tipo),
-- una plantilla puede ser de "pedido" (etiqueta de envío con cliente, peso,
-- medidas y número de bulto). Cada clase tiene su propia plantilla
-- predeterminada. El pedido guarda sus datos de envío (bultos, peso, medidas).
-- =====================================================================

ALTER TABLE label_templates
  ADD COLUMN kind text NOT NULL DEFAULT 'unit' CHECK (kind IN ('unit', 'order'));

DROP INDEX label_templates_default_uq;
CREATE UNIQUE INDEX label_templates_default_uq ON label_templates (company_id, kind) WHERE is_default;

-- Datos de envío del pedido: {"weightUnit":"lb","dimUnit":"in","packages":[{"weight":12.5,"length":24,"width":18,"height":12}]}
ALTER TABLE sales_orders
  ADD COLUMN shipping jsonb NOT NULL DEFAULT '{}'::jsonb;
