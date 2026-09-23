-- =====================================================================
-- 013_push_notifications.sql
-- Notificaciones: bandeja dentro de la app + avisos push (Web Push) al
-- teléfono o a la PC, aunque la app esté cerrada.
--  · app_secrets          claves VAPID del servidor (se generan solas la 1.ª vez)
--  · push_subscriptions   dispositivos/navegadores de cada usuario
--  · notifications        bandeja por usuario y empresa (y cola de envío push)
--  · notification_prefs   qué avisos quiere recibir cada usuario
--  · sales_orders.expiry_notified_at   para avisar una sola vez que una reserva está por vencer
-- =====================================================================

CREATE TABLE app_secrets (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Un dispositivo (navegador) pertenece a un usuario; recibe los avisos de todas sus empresas.
CREATE TABLE push_subscriptions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint     text NOT NULL UNIQUE,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  user_agent   text,
  failures     int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

CREATE TABLE notifications (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  bigint NOT NULL REFERENCES companies(id),
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event       text NOT NULL,                       -- clave del aviso, ej. 'order_expiring'
  title       text NOT NULL,
  body        text,
  url         text,                                -- pantalla a la que lleva al tocarlo
  in_app      boolean NOT NULL DEFAULT true,       -- false = solo push (el usuario apagó la bandeja para este aviso)
  push_state  text NOT NULL DEFAULT 'pending' CHECK (push_state IN ('pending', 'sent', 'skipped', 'failed')),
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);
CREATE INDEX notifications_user_idx ON notifications (company_id, user_id, created_at DESC);
CREATE INDEX notifications_push_idx ON notifications (company_id, id) WHERE push_state = 'pending';
SELECT apply_tenant_rls('notifications');

CREATE TABLE notification_prefs (
  company_id  bigint NOT NULL REFERENCES companies(id),
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event       text NOT NULL,
  in_app      boolean NOT NULL DEFAULT true,
  push        boolean NOT NULL DEFAULT true,
  PRIMARY KEY (company_id, user_id, event)
);
SELECT apply_tenant_rls('notification_prefs');

ALTER TABLE sales_orders ADD COLUMN expiry_notified_at timestamptz;
