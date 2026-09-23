-- =====================================================================
-- 012_assets.sql
-- Activos de la empresa: herramientas y equipos propios (no son mercancía
-- para vender). Usan los mismos tipos de equipo y atributos que el
-- inventario, pero no pasan por lotes, testeo, ubicaciones ni pedidos.
-- Su código se genera con su propio consecutivo (formato en ajustes).
-- =====================================================================

CREATE TABLE assets (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id        bigint NOT NULL,
  code              text NOT NULL,
  name              text,                                  -- nombre libre, ej. "Soldador de estaño"
  equipment_type_id bigint NOT NULL,
  serial_number     text,
  specs             jsonb NOT NULL DEFAULT '{}'::jsonb,
  status_id         bigint NOT NULL,                       -- catálogo asset_status
  assigned_to       text,                                  -- responsable / quién lo tiene
  location          text,                                  -- dónde está (texto libre)
  acquired_at       date,
  notes             text,
  created_by        bigint REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, equipment_type_id) REFERENCES equipment_types (company_id, id),
  FOREIGN KEY (company_id, status_id)         REFERENCES catalog_items (company_id, id)
);
CREATE UNIQUE INDEX assets_serial_uq ON assets (company_id, lower(serial_number)) WHERE serial_number IS NOT NULL;
CREATE INDEX assets_status_idx ON assets (company_id, status_id);
CREATE INDEX assets_type_idx   ON assets (company_id, equipment_type_id);
SELECT add_updated_at_trigger('assets');
SELECT apply_tenant_rls('assets');
