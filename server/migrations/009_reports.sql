-- =====================================================================
-- 009_reports.sql
-- Reportes personalizados. Cada reporte guarda su definición (columnas,
-- filtros, orden, agrupación) como JSON sobre un "conjunto de datos"
-- (equipos, lotes, pedidos...). Puede ser:
--   · privado  → solo lo ve quien lo creó
--   · company  → lo ven todos los usuarios de la empresa que tengan
--                permiso sobre la información que usa
-- Los reportes de sistema (system_key) vienen de fábrica y no se editan.
-- =====================================================================

CREATE TABLE reports (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id          bigint NOT NULL REFERENCES companies(id),
  name                text NOT NULL CHECK (length(btrim(name)) > 0),
  description         text,
  dataset             text NOT NULL,
  definition          jsonb NOT NULL,
  owner_membership_id bigint,
  visibility          text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'company')),
  system_key          text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, owner_membership_id) REFERENCES memberships (company_id, id),
  CHECK (visibility = 'company' OR owner_membership_id IS NOT NULL)
);
CREATE UNIQUE INDEX reports_system_key_uq ON reports (company_id, system_key) WHERE system_key IS NOT NULL;
CREATE INDEX reports_owner_idx ON reports (company_id, owner_membership_id);
SELECT add_updated_at_trigger('reports');
SELECT apply_tenant_rls('reports');
