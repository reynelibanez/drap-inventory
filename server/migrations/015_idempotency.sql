-- =====================================================================
-- 015_idempotency.sql
-- Trabajo sin conexión: la app guarda en el teléfono las acciones que el
-- usuario hace sin internet y las envía al volver la conexión. Cada acción
-- lleva una llave única (cabecera Idempotency-Key). Si un envío se corta a
-- la mitad y se repite, el servidor devuelve la respuesta ya guardada en
-- vez de crear el registro dos veces.
-- =====================================================================

CREATE TABLE idempotency_keys (
  company_id  bigint NOT NULL REFERENCES companies(id),
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key         text NOT NULL CHECK (char_length(key) BETWEEN 8 AND 100),
  method      text NOT NULL,
  path        text NOT NULL,
  status      int NOT NULL,
  response    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
SELECT apply_tenant_rls('idempotency_keys');
