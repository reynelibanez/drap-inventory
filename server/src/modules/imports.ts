import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { route, zId } from '../http.js';
import { badRequest } from '../errors.js';
import { parseCsv, IMPORT_MAX_ROWS } from '../services/csv.js';
import { performImport, type ImportMapping } from '../services/importer.js';

const mappingSchema: z.ZodType<ImportMapping> = z.object({
  serialCol: z.number().int().min(0).nullable(),
  referenceCol: z.number().int().min(0).nullable(),
  notesCol: z.number().int().min(0).nullable(),
  extraCols: z.array(z.number().int().min(0)).max(200).default([]),
  attrs: z.record(z.string(), z.number().int().min(0).nullable()).default({}),
});

const importBody = z.object({
  equipmentTypeId: zId,
  csv: z.string().min(1).max(1_800_000),
  mapping: mappingSchema,
  lotReference: z.string().trim().max(100).nullish(),
});

function parseDataRows(csv: string): { headers: string[]; dataRows: string[][] } {
  const all = parseCsv(csv);
  if (!all.length) throw badRequest('empty_csv');
  const [headers, ...dataRows] = all;
  if (dataRows.length > IMPORT_MAX_ROWS) throw badRequest('too_many_rows', { max: IMPORT_MAX_ROWS });
  return { headers, dataRows };
}

export async function importRoutes(app: FastifyInstance) {
  // Solo analiza el archivo (encabezados + una muestra) para armar la pantalla de mapeo de columnas: no toca la base.
  app.post('/api/imports/inspect', route('lots.import', async (c) => {
    const { csv } = c.body(z.object({ csv: z.string().min(1).max(1_800_000) }));
    const all = parseCsv(csv);
    if (!all.length) throw badRequest('empty_csv');
    const [headers, ...dataRows] = all;
    if (dataRows.length > IMPORT_MAX_ROWS) throw badRequest('too_many_rows', { max: IMPORT_MAX_ROWS });
    return { headers, rowCount: dataRows.length, sample: dataRows.slice(0, 8) };
  }));

  // Vista previa: corre la importación completa de verdad (crea el lote y los equipos) y al final revierte todo
  // (SAVEPOINT), así se ve exactamente lo que pasaría sin dejar nada guardado. Usa el mismo código que confirmar.
  app.post('/api/imports/preview', route('lots.import', async (c) => {
    const b = c.body(importBody);
    const { headers, dataRows } = parseDataRows(b.csv);
    await c.db.query('SAVEPOINT import_preview');
    try {
      const outcome = await performImport(c, { equipmentTypeId: b.equipmentTypeId, headers, dataRows, mapping: b.mapping, lotReference: b.lotReference ?? null });
      return { ...outcome, preview: true };
    } finally {
      await c.db.query('ROLLBACK TO SAVEPOINT import_preview');
    }
  }));

  // Confirmar: igual que la vista previa, pero queda guardado.
  app.post('/api/imports/commit', route('lots.import', async (c) => {
    const b = c.body(importBody);
    const { headers, dataRows } = parseDataRows(b.csv);
    const outcome = await performImport(c, { equipmentTypeId: b.equipmentTypeId, headers, dataRows, mapping: b.mapping, lotReference: b.lotReference ?? null });
    return { ...outcome, preview: false };
  }));
}
