-- =====================================================================
-- 016_costs_prices.sql
-- Costos del lote (distribuidos entre sus equipos con un plan de reglas), costos por equipo,
-- precios de lista por equipo y reglas de precio, y ajustes (descuentos/cargos) del pedido.
-- =====================================================================

-- ---------- Costos ----------
-- lots.total_cost (ya existía) = costo de la mercancía. Aquí se guardan el plan de reparto y su último resultado.
ALTER TABLE lots
  ADD COLUMN cost_plan         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- plan de reparto (reglas), ver services/costs.ts
  ADD COLUMN cost_applied_at   timestamptz,                          -- null = todavía no se ha repartido
  ADD COLUMN cost_applied_by   bigint REFERENCES users(id);

-- Costos adicionales del lote (flete, aranceles, impuestos...). "distribute" = se suman a lo que se reparte entre los equipos.
CREATE TABLE lot_costs (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL,
  lot_id     bigint NOT NULL,
  label      text NOT NULL,
  amount     numeric(14,2) NOT NULL CHECK (amount >= 0),
  distribute boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, lot_id) REFERENCES lots (company_id, id) ON DELETE CASCADE
);
CREATE INDEX lot_costs_lot_idx ON lot_costs (lot_id);
SELECT apply_tenant_rls('lot_costs');

-- Planes de reparto guardados para reutilizarlos en otros lotes.
CREATE TABLE cost_templates (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL REFERENCES companies(id),
  name       text NOT NULL,
  plan       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);
CREATE UNIQUE INDEX cost_templates_name_uq ON cost_templates (company_id, lower(name));
SELECT apply_tenant_rls('cost_templates');

-- Costo por equipo de cada línea del lote (resultado del reparto): los equipos nuevos de la línea lo heredan.
ALTER TABLE lot_lines ADD COLUMN unit_cost numeric(14,4) CHECK (unit_cost IS NULL OR unit_cost >= 0);

-- Costo y precio de lista de cada equipo.
--  cost_source: 'plan' = viene del reparto del lote; 'manual' = fijado a mano (el reparto lo respeta).
--  price_source: 'rule' = calculado por las reglas de precio; 'manual' = fijado a mano (las reglas lo respetan).
ALTER TABLE units
  ADD COLUMN cost         numeric(14,4) CHECK (cost IS NULL OR cost >= 0),
  ADD COLUMN cost_source  text CHECK (cost_source IN ('plan', 'manual')),
  ADD COLUMN list_price   numeric(14,2) CHECK (list_price IS NULL OR list_price >= 0),
  ADD COLUMN price_source text CHECK (price_source IN ('rule', 'manual'));
CREATE INDEX units_lot_cost_idx ON units (lot_id) WHERE cost IS NOT NULL;

-- ---------- Reglas de precio de lista ----------
CREATE TABLE price_rules (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL REFERENCES companies(id),
  sort_order int NOT NULL DEFAULT 0,
  name       text NOT NULL DEFAULT '',
  enabled    boolean NOT NULL DEFAULT true,
  match      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- typeIds, specs, cosmeticGradeIds, functionalGradeIds, lotIds, costMin, costMax
  method     text NOT NULL CHECK (method IN ('fixed', 'markup_pct', 'margin_pct', 'add_amount')),
  value      numeric(14,4) NOT NULL,
  rounding   text NOT NULL DEFAULT 'none' CHECK (rounding IN ('none', 'unit', 'five', 'ten', 'x99')),
  min_price  numeric(14,2) CHECK (min_price IS NULL OR min_price >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);
SELECT add_updated_at_trigger('price_rules');
SELECT apply_tenant_rls('price_rules');

-- ---------- Pedido: descuentos y cargos ----------
-- [{label, kind: 'percent'|'amount', value}]  (valor con signo: negativo = descuento, positivo = cargo). El % es sobre el subtotal.
ALTER TABLE sales_orders ADD COLUMN adjustments jsonb NOT NULL DEFAULT '[]'::jsonb;
