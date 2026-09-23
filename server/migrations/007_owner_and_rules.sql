-- =====================================================================
-- 007_owner_and_rules.sql
--  1) Administrador principal único (el que se crea en el setup).
--  2) Reglas de ubicación por nivel de rack: tipo de equipo, grados y
--     agrupación por propiedades (en el orden que se elija).
-- =====================================================================

-- 1) Solo puede existir UN administrador principal (users.is_platform_admin).
--    Si por alguna razón hubiera más de uno, se conserva el primero creado y los demás
--    pasan a ser usuarios normales (siguen siendo administradores de sus empresas).
UPDATE users SET is_platform_admin = false
 WHERE is_platform_admin AND id <> (SELECT min(id) FROM users WHERE is_platform_admin);
CREATE UNIQUE INDEX users_single_owner_uq ON users ((true)) WHERE is_platform_admin;

-- 2) Regla de cada nivel de un rack.
CREATE TABLE rack_level_rules (
  company_id          bigint NOT NULL,
  rack_id             bigint NOT NULL,
  level_no            int    NOT NULL CHECK (level_no > 0),
  equipment_type_id   bigint,                                   -- null = cualquier tipo
  cosmetic_grade_ids  bigint[] NOT NULL DEFAULT '{}',           -- vacío = cualquier grado cosmético
  functional_grade_ids bigint[] NOT NULL DEFAULT '{}',          -- vacío = cualquier grado funcional
  group_by            text[]   NOT NULL DEFAULT '{}',           -- claves de atributo, en orden de agrupación
  strict              boolean  NOT NULL DEFAULT true,           -- true: un espacio = un solo grupo (no se mezclan)
  PRIMARY KEY (rack_id, level_no),
  FOREIGN KEY (company_id, rack_id) REFERENCES racks (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, equipment_type_id) REFERENCES equipment_types (company_id, id)
);
SELECT apply_tenant_rls('rack_level_rules');
