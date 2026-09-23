-- =====================================================================
-- 010_quick_sales.sql
-- Venta rápida: se venden equipos sin crear un pedido ni indicar cliente.
-- Queda registrada como una venta ya completada (is_quick) para que salga en
-- reportes, historial y packing list como cualquier otra.
-- =====================================================================

ALTER TABLE sales_orders ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE sales_orders ADD COLUMN is_quick boolean NOT NULL DEFAULT false;
