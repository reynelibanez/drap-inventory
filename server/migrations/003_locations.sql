-- =====================================================================
-- 003_locations.sql
-- Ubicaciones: almacén → área → rack → niveles (pisos) → espacios.
-- Cada rack se personaliza por nivel: cuántos espacios y qué capacidad tiene cada uno.
-- =====================================================================

CREATE TABLE warehouses (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL REFERENCES companies(id),
  code       text NOT NULL,
  name       text NOT NULL,
  address    text,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, id)
);
SELECT add_updated_at_trigger('warehouses');

CREATE TABLE areas (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   bigint NOT NULL,
  warehouse_id bigint NOT NULL,
  code         text NOT NULL,
  name         text NOT NULL,
  description  text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, code),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouses (company_id, id)
);
SELECT add_updated_at_trigger('areas');

-- Tipos de equipo preferidos en un área (ayuda a la ubicación inteligente).
CREATE TABLE area_equipment_types (
  company_id        bigint NOT NULL,
  area_id           bigint NOT NULL,
  equipment_type_id bigint NOT NULL,
  PRIMARY KEY (area_id, equipment_type_id),
  FOREIGN KEY (company_id, area_id) REFERENCES areas (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, equipment_type_id) REFERENCES equipment_types (company_id, id) ON DELETE CASCADE
);

CREATE TABLE racks (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL,
  area_id    bigint NOT NULL,
  code       text NOT NULL,
  name       text,
  notes      text,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (area_id, code),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, area_id) REFERENCES areas (company_id, id)
);
SELECT add_updated_at_trigger('racks');

-- Un espacio concreto donde se guardan equipos: nivel N, posición M, con capacidad.
CREATE TABLE slots (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL,
  rack_id    bigint NOT NULL,
  level_no   int NOT NULL CHECK (level_no > 0),
  slot_no    int NOT NULL CHECK (slot_no > 0),
  code       text NOT NULL,                        -- ej. 'ALM1/A/R03/2-4'
  capacity   int NOT NULL CHECK (capacity > 0),    -- cuántas unidades caben
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rack_id, level_no, slot_no),
  UNIQUE (company_id, code),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, rack_id) REFERENCES racks (company_id, id) ON DELETE CASCADE
);
SELECT add_updated_at_trigger('slots');

SELECT apply_tenant_rls('warehouses');
SELECT apply_tenant_rls('areas');
SELECT apply_tenant_rls('area_equipment_types');
SELECT apply_tenant_rls('racks');
SELECT apply_tenant_rls('slots');
