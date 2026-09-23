-- =====================================================================
-- 001_core.sql
-- Núcleo: empresas (multi-tenant), usuarios, membresías, roles/permisos,
-- secuencias de códigos, auditoría y utilidades de seguridad por fila (RLS).
-- Compatible con PostgreSQL 13+.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Utilidades
-- ---------------------------------------------------------------------

-- Empresa activa de la transacción actual (la fija el backend con set_config).
CREATE FUNCTION app_company_id() RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.company_id', true), '')::bigint
$$;

CREATE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

-- Activa updated_at automático en una tabla.
CREATE FUNCTION add_updated_at_trigger(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON %s
       FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', tbl);
END $$;

-- Activa aislamiento por empresa (RLS) en una tabla con columna company_id.
-- FORCE hace que aplique incluso al dueño de la tabla (solo un superusuario lo salta).
CREATE FUNCTION apply_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s
       USING (company_id = app_company_id())
       WITH CHECK (company_id = app_company_id())', tbl);
END $$;

-- Un nombre traducible es un objeto JSON {"es": "...", "en": "..."} con al menos un idioma.
CREATE FUNCTION is_i18n(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT v IS NOT NULL AND jsonb_typeof(v) = 'object' AND v <> '{}'::jsonb
$$;

-- ---------------------------------------------------------------------
-- Empresas y usuarios (capa de identidad: NO llevan RLS, el backend filtra)
-- ---------------------------------------------------------------------

CREATE TABLE companies (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug             text NOT NULL,
  name             text NOT NULL,
  legal_name       text,
  tax_id           text,
  default_language text NOT NULL DEFAULT 'es' CHECK (default_language IN ('es','en')),
  currency         char(3) NOT NULL DEFAULT 'USD',
  timezone         text NOT NULL DEFAULT 'America/New_York',
  -- Ajustes configurables: formato de código de unidad, días de reserva, pesos de ubicación, etc.
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companies_slug_uq ON companies (lower(slug));
SELECT add_updated_at_trigger('companies');

CREATE TABLE users (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username             text NOT NULL,
  email                text,
  full_name            text NOT NULL,
  password_hash        text NOT NULL,
  language             text CHECK (language IN ('es','en')),  -- preferencia personal (null = la de la empresa)
  is_platform_admin    boolean NOT NULL DEFAULT false,
  is_active            boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_uq ON users (lower(username));
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE email IS NOT NULL;
SELECT add_updated_at_trigger('users');

-- Un usuario puede pertenecer a varias empresas (una membresía por empresa).
CREATE TABLE memberships (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id       bigint NOT NULL REFERENCES companies(id),
  user_id          bigint NOT NULL REFERENCES users(id),
  -- Número de técnico dentro de la empresa: forma parte del código de cada equipo (ej. 1t120).
  tech_number      int NOT NULL CHECK (tech_number > 0),
  -- Administrador de la empresa: acceso total dentro de ella (evita quedarse sin acceso).
  is_company_admin boolean NOT NULL DEFAULT false,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, user_id),
  UNIQUE (company_id, tech_number),
  UNIQUE (company_id, id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);
SELECT add_updated_at_trigger('memberships');

-- Sesiones renovables. El token real nunca se guarda: solo su hash.
CREATE TABLE refresh_tokens (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id   bigint REFERENCES companies(id) ON DELETE CASCADE,  -- última empresa activa
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  user_agent   text,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

-- ---------------------------------------------------------------------
-- Permisos (catálogo global sincronizado desde el código) y roles por empresa
-- ---------------------------------------------------------------------

CREATE TABLE permissions (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key         text NOT NULL UNIQUE,            -- ej. 'lots.count'
  module      text NOT NULL,                   -- ej. 'lots'
  name        jsonb NOT NULL CHECK (is_i18n(name)),
  description jsonb,
  sort_order  int NOT NULL DEFAULT 0
);

CREATE TABLE roles (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  bigint NOT NULL REFERENCES companies(id),
  name        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name),
  UNIQUE (company_id, id)
);
SELECT add_updated_at_trigger('roles');

CREATE TABLE role_permissions (
  company_id    bigint NOT NULL,
  role_id       bigint NOT NULL,
  permission_id int NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id),
  FOREIGN KEY (company_id, role_id) REFERENCES roles (company_id, id) ON DELETE CASCADE
);

-- Un usuario puede tener varios roles en una empresa.
CREATE TABLE membership_roles (
  company_id    bigint NOT NULL,
  membership_id bigint NOT NULL,
  role_id       bigint NOT NULL,
  PRIMARY KEY (membership_id, role_id),
  FOREIGN KEY (company_id, membership_id) REFERENCES memberships (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, role_id) REFERENCES roles (company_id, id) ON DELETE CASCADE
);

-- Excepciones por usuario: permitir o denegar una función concreta sin importar sus roles.
CREATE TABLE membership_permissions (
  company_id    bigint NOT NULL,
  membership_id bigint NOT NULL,
  permission_id int NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  effect        text NOT NULL CHECK (effect IN ('allow','deny')),
  PRIMARY KEY (membership_id, permission_id),
  FOREIGN KEY (company_id, membership_id) REFERENCES memberships (company_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- Secuencias de códigos por empresa (lotes, técnicos, ventas...). Atómicas.
-- ---------------------------------------------------------------------

CREATE TABLE code_sequences (
  company_id bigint NOT NULL REFERENCES companies(id),
  key        text NOT NULL,
  value      bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, key)
);

-- Devuelve el siguiente número de la secuencia. El bloqueo de fila serializa
-- a quienes piden la MISMA clave y se libera al confirmar la transacción,
-- por lo que no quedan huecos si la operación falla.
CREATE FUNCTION next_seq(p_key text) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO code_sequences (company_id, key, value)
  VALUES (app_company_id(), p_key, 1)
  ON CONFLICT (company_id, key) DO UPDATE SET value = code_sequences.value + 1
  RETURNING value
$$;

-- ---------------------------------------------------------------------
-- Auditoría
-- ---------------------------------------------------------------------

CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES companies(id),
  at            timestamptz NOT NULL DEFAULT now(),
  user_id       bigint REFERENCES users(id),
  action        text NOT NULL,           -- ej. 'unit.status_changed'
  entity        text NOT NULL,           -- ej. 'unit'
  entity_id     bigint,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip            text
);
CREATE INDEX audit_entity_idx ON audit_log (company_id, entity, entity_id, at DESC);
CREATE INDEX audit_at_idx ON audit_log (company_id, at DESC);

-- ---------------------------------------------------------------------
-- RLS en las tablas por empresa de este archivo
-- ---------------------------------------------------------------------
SELECT apply_tenant_rls('roles');
SELECT apply_tenant_rls('role_permissions');
SELECT apply_tenant_rls('membership_roles');
SELECT apply_tenant_rls('membership_permissions');
SELECT apply_tenant_rls('code_sequences');
SELECT apply_tenant_rls('audit_log');
