-- =====================================================================
-- 005_sales.sql
-- Clientes, vendedores y pedidos de venta con reserva de equipos.
-- =====================================================================

CREATE TABLE customers (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id       bigint NOT NULL REFERENCES companies(id),
  name             text NOT NULL,
  customer_type_id bigint,                          -- catálogo customer_type
  contact_name     text,
  email            text,
  phone            text,
  country          text,
  address          text,
  tax_id           text,
  notes            text,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, customer_type_id) REFERENCES catalog_items (company_id, id)
);
CREATE INDEX customers_name_idx ON customers (company_id, lower(name));
SELECT add_updated_at_trigger('customers');

-- Vendedor: puede ser un usuario del sistema o una persona externa.
CREATE TABLE sellers (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES companies(id),
  name          text NOT NULL,
  email         text,
  phone         text,
  membership_id bigint,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, membership_id) REFERENCES memberships (company_id, id)
);
SELECT add_updated_at_trigger('sellers');

-- Pedido de venta. Código tipo V2609-0001.
-- Estado (catálogo order_status): abierto (equipos reservados) → completado / cancelado.
CREATE TABLE sales_orders (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id     bigint NOT NULL REFERENCES companies(id),
  code           text NOT NULL,
  customer_id    bigint NOT NULL,
  seller_id      bigint,
  status_id      bigint NOT NULL,
  currency       char(3) NOT NULL DEFAULT 'USD',
  reserved_until timestamptz,                       -- si vence, se liberan los equipos
  notes          text,
  created_by     bigint REFERENCES users(id),
  completed_at   timestamptz,
  cancelled_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, customer_id) REFERENCES customers (company_id, id),
  FOREIGN KEY (company_id, seller_id)   REFERENCES sellers (company_id, id),
  FOREIGN KEY (company_id, status_id)   REFERENCES catalog_items (company_id, id)
);
CREATE INDEX sales_orders_status_idx ON sales_orders (company_id, status_id);
CREATE INDEX sales_orders_customer_idx ON sales_orders (customer_id);
SELECT add_updated_at_trigger('sales_orders');

-- Equipos del pedido. Una unidad solo puede estar en UN pedido activo a la vez.
CREATE TABLE sale_items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  bigint NOT NULL,
  order_id    bigint NOT NULL,
  unit_id     bigint NOT NULL,
  unit_price  numeric(14,2) CHECK (unit_price IS NULL OR unit_price >= 0),
  added_at    timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,                          -- cuando se quitó del pedido / se canceló
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, order_id) REFERENCES sales_orders (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, unit_id)  REFERENCES units (company_id, id)
);
CREATE UNIQUE INDEX sale_items_active_unit_uq ON sale_items (unit_id) WHERE released_at IS NULL;
CREATE INDEX sale_items_order_idx ON sale_items (order_id);

SELECT apply_tenant_rls('customers');
SELECT apply_tenant_rls('sellers');
SELECT apply_tenant_rls('sales_orders');
SELECT apply_tenant_rls('sale_items');
