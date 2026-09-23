-- =====================================================================
-- 014_model_catalogs.sql
-- Catálogos dependientes y listas de modelos por tipo de equipo.
--  · catalogs.parent_catalog_id        el catálogo depende de otro (ej. Modelos de laptop → Marcas)
--  · catalog_items.parent_item_id      cada valor pertenece a un valor del catálogo padre (ej. Latitude 7490 → Dell)
--  · equipment_type_attributes.suggest_catalog_id
--        lista de valores sugeridos para un atributo de texto de ese tipo (el atributo "Modelo" sigue siendo
--        texto para no tocar los datos ya guardados, pero se elige de la lista según la marca y también se puede escribir otro)
-- =====================================================================

ALTER TABLE catalogs ADD COLUMN parent_catalog_id bigint;
ALTER TABLE catalogs ADD CONSTRAINT catalogs_parent_fk
  FOREIGN KEY (company_id, parent_catalog_id) REFERENCES catalogs (company_id, id);

ALTER TABLE catalog_items ADD COLUMN parent_item_id bigint;
ALTER TABLE catalog_items ADD CONSTRAINT catalog_items_parent_fk
  FOREIGN KEY (company_id, parent_item_id) REFERENCES catalog_items (company_id, id);
CREATE INDEX catalog_items_parent_idx ON catalog_items (parent_item_id) WHERE parent_item_id IS NOT NULL;

ALTER TABLE equipment_type_attributes ADD COLUMN suggest_catalog_id bigint;
ALTER TABLE equipment_type_attributes ADD CONSTRAINT eta_suggest_fk
  FOREIGN KEY (company_id, suggest_catalog_id) REFERENCES catalogs (company_id, id);
