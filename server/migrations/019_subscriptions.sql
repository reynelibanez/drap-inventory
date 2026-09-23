-- =====================================================================
-- 019_subscriptions.sql
-- Sistema de suscripciones por empresa: prueba gratis de 30 días y dos
-- planes pagos (Business y Enterprise), mensual o anual, con pagos por
-- Stripe. El admin de plataforma puede cambiar el plan de cualquier
-- empresa sin necesidad de pago (anulación manual).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Catálogo de planes (editable desde el panel del admin de plataforma,
-- así los precios y límites no quedan fijos en el código).
-- ---------------------------------------------------------------------
CREATE TABLE subscription_plans (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key                      text NOT NULL,             -- 'free' | 'business' | 'enterprise' (u otras futuras)
  name                     jsonb NOT NULL CHECK (is_i18n(name)),
  description              jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Precio en centavos. NULL = no se compra por Stripe (ej. el plan gratis).
  price_monthly_cents      integer CHECK (price_monthly_cents IS NULL OR price_monthly_cents >= 0),
  -- Cargo total por año (no el equivalente mensual): así coincide con el monto real que cobra Stripe.
  price_annual_cents       integer CHECK (price_annual_cents IS NULL OR price_annual_cents >= 0),
  max_users                integer CHECK (max_users IS NULL OR max_users > 0),      -- NULL = sin límite
  max_locations            integer CHECK (max_locations IS NULL OR max_locations > 0), -- NULL = sin límite (almacenes)
  features                 jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { advancedReports, prioritySupport, ... }
  stripe_price_id_monthly  text,
  stripe_price_id_annual   text,
  is_active                boolean NOT NULL DEFAULT true,
  sort_order               integer NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscription_plans_key_uq ON subscription_plans (lower(key));
SELECT add_updated_at_trigger('subscription_plans');

INSERT INTO subscription_plans (key, name, description, price_monthly_cents, price_annual_cents, max_users, max_locations, features, sort_order) VALUES
  ('free', '{"es":"Gratis (prueba 30 días)","en":"Free (30-day trial)"}',
           '{"es":"Acceso completo por 30 días, sin tarjeta","en":"Full access for 30 days, no card required"}',
           NULL, NULL, NULL, NULL, '{"advancedReports":true,"prioritySupport":false}', 0),
  ('business', '{"es":"Business","en":"Business"}',
               '{"es":"Para equipos en crecimiento","en":"For growing teams"}',
               6900, 66000, 5, 2, '{"advancedReports":false,"prioritySupport":false}', 1),
  ('enterprise', '{"es":"Enterprise","en":"Enterprise"}',
                 '{"es":"Sin límites de usuarios ni almacenes, con soporte prioritario","en":"Unlimited users and locations, with priority support"}',
                 19900, 190800, NULL, NULL, '{"advancedReports":true,"prioritySupport":true}', 2);

-- ---------------------------------------------------------------------
-- Suscripción de cada empresa
-- ---------------------------------------------------------------------
ALTER TABLE companies ADD COLUMN plan_id bigint REFERENCES subscription_plans(id);
ALTER TABLE companies ADD COLUMN subscription_status text NOT NULL DEFAULT 'trialing'
  CHECK (subscription_status IN ('trialing', 'active', 'past_due', 'canceled', 'expired'));
ALTER TABLE companies ADD COLUMN billing_interval text CHECK (billing_interval IN ('monthly', 'annual'));
ALTER TABLE companies ADD COLUMN trial_ends_at timestamptz;
ALTER TABLE companies ADD COLUMN subscription_current_period_end timestamptz;
ALTER TABLE companies ADD COLUMN subscription_canceled_at timestamptz;
ALTER TABLE companies ADD COLUMN stripe_customer_id text;
ALTER TABLE companies ADD COLUMN stripe_subscription_id text;

CREATE UNIQUE INDEX companies_stripe_customer_uq ON companies (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE UNIQUE INDEX companies_stripe_subscription_uq ON companies (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

-- Empresas existentes: arrancan un período de prueba de 30 días con el plan gratis desde hoy.
UPDATE companies SET plan_id = (SELECT id FROM subscription_plans WHERE key = 'free'),
                      trial_ends_at = now() + interval '30 days'
 WHERE plan_id IS NULL;

-- ---------------------------------------------------------------------
-- Eventos de Stripe ya procesados (evita aplicar un webhook dos veces).
-- ---------------------------------------------------------------------
CREATE TABLE stripe_events (
  id          text PRIMARY KEY,   -- id del evento de Stripe (evt_...)
  type        text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
