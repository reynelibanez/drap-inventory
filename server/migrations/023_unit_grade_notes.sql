-- =====================================================================
-- 023_unit_grade_notes.sql
-- Una nota aparte para el grado cosmético y otra para el funcional (además de la nota general que ya existía),
-- para poder anotar, por ejemplo, "rayón en la tapa" junto al grado cosmético y "batería al 80%" junto al
-- funcional, sin mezclarlo todo en una sola nota.
-- =====================================================================

ALTER TABLE units
  ADD COLUMN cosmetic_grade_note   text,
  ADD COLUMN functional_grade_note text;
