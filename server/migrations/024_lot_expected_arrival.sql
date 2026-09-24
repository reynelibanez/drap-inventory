-- =====================================================================
-- 024_lot_expected_arrival.sql
-- Fecha de posible entrada: cuando se registra un lote que todavía no llegó físicamente (por ejemplo, uno que se
-- acaba de comprar a un proveedor), permite anotar para cuándo se espera que llegue. Es solo informativa (no
-- dispara ningún cambio de estado) y opcional: si no se sabe, se deja en blanco.
-- =====================================================================

ALTER TABLE lots
  ADD COLUMN expected_arrival_date date;
