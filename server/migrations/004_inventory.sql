-- =====================================================================
-- 004_inventory.sql
-- Proveedores, lotes, líneas de lote (esperado vs. contado) y unidades.
-- =====================================================================

CREATE TABLE suppliers (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   bigint NOT NULL REFERENCES companies(id),
  name         text NOT NULL,
  contact_name text,
  email        text,
  phone        text,
  country      text,
  address      text,
  notes        text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);
CREATE UNIQUE INDEX suppliers_name_uq ON suppliers (company_id, lower(name));
SELECT add_updated_at_trigger('suppliers');

-- Lote de compra. Código tipo L260901 (L + año + mes + consecutivo del mes).
CREATE TABLE lots (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES companies(id),
  code          text NOT NULL,
  supplier_id   bigint,
  status_id     bigint NOT NULL,                   -- catálogo lot_status
  purchase_date date NOT NULL DEFAULT current_date,
  reference     text,                              -- factura / orden de compra
  currency      char(3) NOT NULL DEFAULT 'USD',
  total_cost    numeric(14,2) CHECK (total_cost IS NULL OR total_cost >= 0),
  notes         text,
  created_by    bigint REFERENCES users(id),
  counted_at    timestamptz,
  closed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, supplier_id) REFERENCES suppliers (company_id, id),
  FOREIGN KEY (company_id, status_id)   REFERENCES catalog_items (company_id, id)
);
CREATE INDEX lots_status_idx ON lots (company_id, status_id);
SELECT add_updated_at_trigger('lots');

-- Línea del lote: "N equipos de este tipo/especificación". Lleva lo esperado y lo contado.
CREATE TABLE lot_lines (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id        bigint NOT NULL,
  lot_id            bigint NOT NULL,
  line_no           int NOT NULL,
  equipment_type_id bigint NOT NULL,
  specs             jsonb NOT NULL DEFAULT '{}'::jsonb,   -- atributos de la línea (marca, modelo, CPU...)
  expected_qty      int NOT NULL DEFAULT 0 CHECK (expected_qty >= 0),
  counted_qty       int CHECK (counted_qty IS NULL OR counted_qty >= 0),  -- null = aún sin contar
  is_unexpected     boolean NOT NULL DEFAULT false,       -- apareció en el conteo y no estaba en el lote
  counted_by        bigint REFERENCES users(id),
  counted_at        timestamptz,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lot_id, line_no),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, lot_id) REFERENCES lots (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, equipment_type_id) REFERENCES equipment_types (company_id, id)
);
SELECT add_updated_at_trigger('lot_lines');

-- Unidad física individual (un equipo). Se crea al testearla y queda ligada a su lote.
-- Código: {lote}-{técnico}t{registro}, ej. L260901-1t120 (formato configurable por empresa).
CREATE TABLE units (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id           bigint NOT NULL,
  code                 text NOT NULL,
  lot_id               bigint NOT NULL,
  lot_line_id          bigint,
  equipment_type_id    bigint NOT NULL,
  tester_membership_id bigint NOT NULL,
  tester_number        int NOT NULL,                   -- copia del número de técnico al momento del registro
  tester_seq           int NOT NULL,                   -- registro propio de ese técnico (no reinicia por lote)
  serial_number        text,
  specs                jsonb NOT NULL DEFAULT '{}'::jsonb,
  cosmetic_grade_id    bigint,
  functional_grade_id  bigint,
  status_id            bigint NOT NULL,                -- catálogo unit_status
  slot_id              bigint,
  notes                text,
  tested_at            timestamptz,                    -- cuando terminó el testeo
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, tester_number, tester_seq),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, lot_id)              REFERENCES lots (company_id, id),
  FOREIGN KEY (company_id, lot_line_id)         REFERENCES lot_lines (company_id, id),
  FOREIGN KEY (company_id, equipment_type_id)   REFERENCES equipment_types (company_id, id),
  FOREIGN KEY (company_id, tester_membership_id) REFERENCES memberships (company_id, id),
  FOREIGN KEY (company_id, cosmetic_grade_id)   REFERENCES catalog_items (company_id, id),
  FOREIGN KEY (company_id, functional_grade_id) REFERENCES catalog_items (company_id, id),
  FOREIGN KEY (company_id, status_id)           REFERENCES catalog_items (company_id, id),
  FOREIGN KEY (company_id, slot_id)             REFERENCES slots (company_id, id)
);
-- Un número de serie no puede repetirse dentro de la empresa.
CREATE UNIQUE INDEX units_serial_uq ON units (company_id, lower(serial_number)) WHERE serial_number IS NOT NULL;
CREATE INDEX units_lot_idx     ON units (lot_id);
CREATE INDEX units_line_idx    ON units (lot_line_id);
CREATE INDEX units_status_idx  ON units (company_id, status_id);
CREATE INDEX units_slot_idx    ON units (slot_id) WHERE slot_id IS NOT NULL;
CREATE INDEX units_type_idx    ON units (company_id, equipment_type_id);
CREATE INDEX units_specs_gin   ON units USING gin (specs jsonb_path_ops);
SELECT add_updated_at_trigger('units');

SELECT apply_tenant_rls('suppliers');
SELECT apply_tenant_rls('lots');
SELECT apply_tenant_rls('lot_lines');
SELECT apply_tenant_rls('units');
