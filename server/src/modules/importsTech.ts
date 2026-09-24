import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { route } from '../http.js';
import { badRequest } from '../errors.js';
import { parseCsv, IMPORT_MAX_ROWS } from '../services/csv.js';
import { performImportTech, resolveTechColumns } from '../services/importerTech.js';

const csvBody = z.object({ csv: z.string().min(1).max(1_800_000), verifyOnTest: z.boolean().default(false) });

function parseDataRows(csv: string): { headers: string[]; dataRows: string[][] } {
  const all = parseCsv(csv);
  if (!all.length) throw badRequest('empty_csv');
  const [headers, ...dataRows] = all;
  if (dataRows.length > IMPORT_MAX_ROWS) throw badRequest('too_many_rows', { max: IMPORT_MAX_ROWS });
  return { headers, dataRows };
}

/**
 * Importación independiente para la plantilla de "control técnico" (columnas fijas, con una columna de tipo de
 * equipo por fila): mismas rutas de inspeccionar/vista previa/confirmar que la importación genérica, pero sin
 * mapeo de columnas a mano (se ubican solas por su encabezado) y puede crear varios lotes en una sola corrida
 * (uno por cada valor de la columna LOTE).
 */
export async function importTechRoutes(app: FastifyInstance) {
  // Solo analiza el archivo: confirma que tiene la forma esperada y arma un resumen por lote/tipo para mostrar antes de importar.
  app.post('/api/imports/tech/inspect', route('lots.import', async (c) => {
    const { csv } = c.body(csvBody);
    const { headers, dataRows } = parseDataRows(csv);
    const cols = resolveTechColumns(headers); // valida la forma del archivo (lanza un error claro si no coincide)

    const byLote = new Map<string, { ref: string | null; count: number }>();
    for (const row of dataRows) {
      const lote = (row[cols.lote] ?? '').trim() || '—';
      const g = byLote.get(lote) ?? { ref: null, count: 0 };
      if (!g.ref) { const r = (row[cols.ref] ?? '').trim(); if (r) g.ref = r; }
      g.count++;
      byLote.set(lote, g);
    }
    const lots = [...byLote.entries()].map(([lote, g]) => ({ lote, reference: g.ref, rowCount: g.count }));
    return { headers, rowCount: dataRows.length, lots, sample: dataRows.slice(0, 8) };
  }));

  // Vista previa: igual que la importación genérica, corre todo de verdad y revierte al final (SAVEPOINT).
  app.post('/api/imports/tech/preview', route('lots.import', async (c) => {
    const { csv, verifyOnTest } = c.body(csvBody);
    const { headers, dataRows } = parseDataRows(csv);
    await c.db.query('SAVEPOINT import_tech_preview');
    try {
      const outcome = await performImportTech(c, headers, dataRows, { verifyOnTest });
      return { ...outcome, preview: true };
    } finally {
      await c.db.query('ROLLBACK TO SAVEPOINT import_tech_preview');
    }
  }));

  // Confirmar: igual que la vista previa, pero queda guardado.
  app.post('/api/imports/tech/commit', route('lots.import', async (c) => {
    const { csv, verifyOnTest } = c.body(csvBody);
    const { headers, dataRows } = parseDataRows(csv);
    const outcome = await performImportTech(c, headers, dataRows, { verifyOnTest });
    return { ...outcome, preview: false };
  }));
}
