-- =====================================================================
-- 008_order_lines.sql
-- Líneas de pedido: se pide "N equipos de este tipo/características/grado" sin
-- indicar códigos. Los equipos concretos se van agregando (por código, del rack)
-- y el sistema los compara contra las líneas.
-- =====================================================================

CREATE TABLE order_lines (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id           bigint NOT NULL,
  order_id             bigint NOT NULL,
  line_no              int    NOT NULL,
  equipment_type_id    bigint NOT NULL,
  specs                jsonb  NOT NULL DEFAULT '{}'::jsonb,        -- características exigidas (marca, modelo, RAM...)
  cosmetic_grade_ids   bigint[] NOT NULL DEFAULT '{}',              -- vacío = cualquiera
  functional_grade_ids bigint[] NOT NULL DEFAULT '{}',
  quantity             int    NOT NULL CHECK (quantity > 0),
  unit_price           numeric(14,2) CHECK (unit_price IS NULL OR unit_price >= 0),
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (order_id, line_no),
  FOREIGN KEY (company_id, order_id) REFERENCES sales_orders (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, equipment_type_id) REFERENCES equipment_types (company_id, id)
);
SELECT apply_tenant_rls('order_lines');

-- A qué línea corresponde cada equipo agregado y si coincidió con el pedido.
ALTER TABLE sale_items ADD COLUMN line_id bigint;
ALTER TABLE sale_items ADD COLUMN match_status text CHECK (match_status IN ('ok', 'no_match', 'line_full'));
ALTER TABLE sale_items ADD FOREIGN KEY (company_id, line_id) REFERENCES order_lines (company_id, id);
CREATE INDEX sale_items_line_idx ON sale_items (line_id);
