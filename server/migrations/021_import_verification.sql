-- =====================================================================
-- 021_import_verification.sql
-- Importación de lotes con verificación por número de serie: al importar (CSV) se puede pedir que los equipos
-- pasen por testeo en vez de quedar disponibles de una (como hoy). En ese caso se guarda lo que decía el
-- archivo (número de serie y datos técnicos) para poder compararlo después con lo que el técnico confirme al
-- testear cada equipo, y así saber en los reportes cuáles llegaron tal cual y cuáles no.
-- =====================================================================

CREATE TABLE unit_import_snapshots (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    bigint NOT NULL,
  unit_id       bigint NOT NULL,
  lot_id        bigint NOT NULL,
  serial_number text,
  specs         jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, unit_id),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, lot_id)  REFERENCES lots (company_id, id) ON DELETE CASCADE
);
CREATE INDEX unit_import_snapshots_lot_idx ON unit_import_snapshots (lot_id);
SELECT apply_tenant_rls('unit_import_snapshots');
