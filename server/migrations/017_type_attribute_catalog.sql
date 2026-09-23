-- =====================================================================
-- 017_type_attribute_catalog.sql
-- Lista de valores propia de un atributo de "lista" (select) para un tipo de equipo concreto.
--  · equipment_type_attributes.catalog_id  si está, ese tipo usa este catálogo en lugar del que tiene el atributo por omisión
--    (el atributo "Modelo" es de lista y cada tipo de equipo tiene su propio catálogo de modelos, dependiente del de marcas).
-- =====================================================================

ALTER TABLE equipment_type_attributes ADD COLUMN catalog_id bigint;
ALTER TABLE equipment_type_attributes ADD CONSTRAINT eta_catalog_fk
  FOREIGN KEY (company_id, catalog_id) REFERENCES catalogs (company_id, id);
