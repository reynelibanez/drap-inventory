-- =====================================================================
-- 002_catalogs_equipment.sql
-- Catálogos configurables (bilingües), tipos de equipo y atributos dinámicos.
-- Nada de esto está "quemado" en el código: cada empresa define los suyos.
-- =====================================================================

-- Un catálogo es una lista con nombre (grados cosméticos, marcas, estados...).
CREATE TABLE catalogs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  bigint NOT NULL REFERENCES companies(id),
  key         text NOT NULL,                       -- identificador estable, ej. 'cosmetic_grade'
  name        jsonb NOT NULL CHECK (is_i18n(name)),
  description jsonb,
  -- Los catálogos de sistema no se pueden borrar (la lógica del flujo depende de ellos),
  -- pero se pueden renombrar y ampliar con nuevos valores.
  is_system   boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, key),
  UNIQUE (company_id, id)
);
SELECT add_updated_at_trigger('catalogs');

CREATE TABLE catalog_items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  bigint NOT NULL,
  catalog_id  bigint NOT NULL,
  code        text,                                -- código corto visible, ej. 'A'
  name        jsonb NOT NULL CHECK (is_i18n(name)),
  description jsonb,
  color       text CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'),
  sort_order  int NOT NULL DEFAULT 0,
  -- Clave interna SOLO para los pocos valores que la lógica del sistema necesita
  -- (ej. unit_status.available). El nombre, color y orden siguen siendo editables.
  system_key  text,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- reglas por valor, ej. {"sellable": false}
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, catalog_id) REFERENCES catalogs (company_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX catalog_items_code_uq ON catalog_items (catalog_id, lower(code)) WHERE code IS NOT NULL;
CREATE UNIQUE INDEX catalog_items_syskey_uq ON catalog_items (catalog_id, system_key) WHERE system_key IS NOT NULL;
CREATE INDEX catalog_items_catalog_idx ON catalog_items (catalog_id, sort_order);
SELECT add_updated_at_trigger('catalog_items');

-- Tipos de equipo: laptop, PC, monitor, disco, memoria, genérico...
CREATE TABLE equipment_types (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES companies(id),
  key           text NOT NULL,
  name          jsonb NOT NULL CHECK (is_i18n(name)),
  icon          text,                              -- nombre de icono de la UI
  tracks_serial boolean NOT NULL DEFAULT true,     -- ¿lleva número de serie?
  is_system     boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  sort_order    int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, key),
  UNIQUE (company_id, id)
);
SELECT add_updated_at_trigger('equipment_types');

-- Biblioteca de atributos reutilizables (marca, modelo, procesador, RAM...).
CREATE TABLE attribute_definitions (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL REFERENCES companies(id),
  key        text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  label      jsonb NOT NULL CHECK (is_i18n(label)),
  data_type  text NOT NULL CHECK (data_type IN ('text','number','boolean','date','select','multiselect')),
  catalog_id bigint,                                -- lista de opciones para select/multiselect
  unit       text,                                  -- ej. 'GB', '"'
  is_system  boolean NOT NULL DEFAULT false,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, key),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, catalog_id) REFERENCES catalogs (company_id, id),
  CHECK ((data_type IN ('select','multiselect')) = (catalog_id IS NOT NULL))
);
SELECT add_updated_at_trigger('attribute_definitions');

-- Qué atributos usa cada tipo de equipo y en qué etapa se piden.
CREATE TABLE equipment_type_attributes (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id       bigint NOT NULL,
  equipment_type_id bigint NOT NULL,
  attribute_id     bigint NOT NULL,
  sort_order       int NOT NULL DEFAULT 0,
  in_lot_line      boolean NOT NULL DEFAULT false,  -- describe la línea del lote (agrupa equipos parecidos)
  required_on_lot  boolean NOT NULL DEFAULT false,  -- obligatorio al registrar la línea del lote
  required_on_test boolean NOT NULL DEFAULT false,  -- obligatorio para terminar el testeo
  is_active        boolean NOT NULL DEFAULT true,
  UNIQUE (equipment_type_id, attribute_id),
  FOREIGN KEY (company_id, equipment_type_id) REFERENCES equipment_types (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, attribute_id) REFERENCES attribute_definitions (company_id, id)
);

SELECT apply_tenant_rls('catalogs');
SELECT apply_tenant_rls('catalog_items');
SELECT apply_tenant_rls('equipment_types');
SELECT apply_tenant_rls('attribute_definitions');
SELECT apply_tenant_rls('equipment_type_attributes');
