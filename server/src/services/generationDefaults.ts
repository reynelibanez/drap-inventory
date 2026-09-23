import type { Db } from '../db.js';
import { processorGenerationValues } from '../seed/processorData.js';
import { isSeeded, setSeeded } from './modelDefaults.js';

/**
 * "Generación" del procesador: el número de modelo como lo muestra la BIOS (6300U, 3500U…), no "6.ª gen" y sin
 * repetir la familia (no "i5-6300U": el campo "Procesador" ya dice "Intel Core i5").
 * El catálogo depende del catálogo de procesadores (igual que los modelos dependen de la marca): cada número pertenece a su procesador
 * y en el equipo solo salen los del procesador elegido. Idempotente: lo que ya existe no se toca ni se repite.
 */
export async function seedProcessorGenerations(db: Db, companyId: number): Promise<void> {
  const cats = await db.rows<{ id: number; key: string }>(`SELECT id, key FROM catalogs WHERE key IN ('processor', 'processor_generation')`);
  const processor = cats.find((c) => c.key === 'processor')?.id;
  const generation = cats.find((c) => c.key === 'processor_generation')?.id;
  if (processor && generation) {
    await db.query('UPDATE catalogs SET parent_catalog_id = $2 WHERE id = $1 AND parent_catalog_id IS NULL', [generation, processor]);
    // Los valores viejos ("6.ª gen") quedan ocultos para elegir; los equipos que ya los tienen los conservan.
    await db.query(`UPDATE catalog_items SET is_active = false WHERE catalog_id = $1 AND parent_item_id IS NULL AND code ~ '^[0-9]{1,2}$'`, [generation]);

    const families = new Map((await db.rows<{ id: number; name: string }>(
      `SELECT id, lower(name->>'es') AS name FROM catalog_items WHERE catalog_id = $1`, [processor])).map((r) => [r.name, r.id]));
    const parents: number[] = []; const names: string[] = []; const orders: number[] = []; const gens: number[] = [];
    let order = (await db.one<{ n: number }>('SELECT COALESCE(max(sort_order), 0) + 1 AS n FROM catalog_items WHERE catalog_id = $1', [generation])).n;
    for (const v of processorGenerationValues()) {
      const parent = families.get(v.family.toLowerCase());
      if (!parent) continue;   // el procesador que la empresa ya no tiene se omite
      parents.push(parent); names.push(v.name); orders.push(order++); gens.push(v.generation);
    }
    // En bloques: son unos 850 valores.
    for (let i = 0; i < names.length; i += 500) {
      await db.query(
        `INSERT INTO catalog_items (company_id, catalog_id, parent_item_id, name, sort_order, meta)
         SELECT $1, $2, x.parent, jsonb_build_object('es', x.name, 'en', x.name), x.ord, jsonb_build_object('generation', x.gen)
           FROM unnest($3::bigint[], $4::text[], $5::int[], $6::int[]) AS x(parent, name, ord, gen)
          WHERE NOT EXISTS (SELECT 1 FROM catalog_items i WHERE i.catalog_id = $2 AND i.parent_item_id = x.parent AND lower(i.name->>'es') = lower(x.name))`,
        [companyId, generation, parents.slice(i, i + 500), names.slice(i, i + 500), orders.slice(i, i + 500), gens.slice(i, i + 500)]);
    }
  }
  await setSeeded(db, companyId, 'processorGenerations');
}

/** Empresas creadas antes de esta lista: la cargan una sola vez (si la empresa borra valores, no se vuelven a crear). */
export async function ensureProcessorGenerations(db: Db, companyId: number): Promise<void> {
  if (!(await isSeeded(db, companyId, 'processorGenerations'))) await seedProcessorGenerations(db, companyId);
}
