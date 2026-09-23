-- =====================================================================
-- 006_labels.sql
-- Diseños de etiquetas (por ejemplo para impresoras DYMO) y su asociación
-- a tipos de equipo. El diseño (posición, tamaño y contenido de cada
-- elemento) se guarda como JSON; el tamaño de la etiqueta va en milímetros.
-- =====================================================================

CREATE TABLE label_templates (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  bigint NOT NULL REFERENCES companies(id),
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  width_mm    numeric(6,2) NOT NULL CHECK (width_mm BETWEEN 10 AND 300),
  height_mm   numeric(6,2) NOT NULL CHECK (height_mm BETWEEN 10 AND 300),
  rotation    smallint NOT NULL DEFAULT 0 CHECK (rotation IN (0, 90, 180, 270)),
  layout      jsonb NOT NULL DEFAULT '{"elements": []}'::jsonb,
  -- La plantilla predeterminada se usa para los tipos de equipo que no tienen una propia.
  is_default  boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);
CREATE UNIQUE INDEX label_templates_default_uq ON label_templates (company_id) WHERE is_default;
SELECT add_updated_at_trigger('label_templates');

-- Un tipo de equipo usa como máximo una plantilla (la que se imprime al terminar el testeo).
CREATE TABLE label_template_types (
  company_id        bigint NOT NULL,
  template_id       bigint NOT NULL,
  equipment_type_id bigint NOT NULL,
  PRIMARY KEY (equipment_type_id),
  FOREIGN KEY (company_id, template_id)       REFERENCES label_templates (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, equipment_type_id) REFERENCES equipment_types (company_id, id) ON DELETE CASCADE
);
CREATE INDEX label_template_types_tpl_idx ON label_template_types (template_id);

SELECT apply_tenant_rls('label_templates');
SELECT apply_tenant_rls('label_template_types');
