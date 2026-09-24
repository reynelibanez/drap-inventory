-- =====================================================================
-- 022_unit_label_prints.sql
-- Registro de cada vez que se imprime la etiqueta de un equipo: quién y cuándo. Sirve para que, en Testeo,
-- se pueda ver de un vistazo si un equipo ya se imprimió (y quién lo hizo y cuántas veces), sin depender de
-- que alguien se acuerde. Se guarda un registro por cada vez que se manda a imprimir (no por cada copia).
-- =====================================================================

CREATE TABLE unit_label_prints (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  bigint NOT NULL,
  unit_id     bigint NOT NULL,
  printed_by  bigint NOT NULL REFERENCES users(id),
  printed_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id) ON DELETE CASCADE
);
CREATE INDEX unit_label_prints_unit_idx ON unit_label_prints (unit_id, printed_at DESC);
SELECT apply_tenant_rls('unit_label_prints');
