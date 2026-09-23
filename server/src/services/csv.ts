/**
 * Lector de CSV (RFC 4180): entiende campos entre comillas, comas dentro de comillas y comillas dobles escapadas
 * (""), que es justo lo que producen Excel/Sheets al exportar un valor como `15.6"`. Un separador simple por comas
 * rompería esos casos, por eso no se usa `split(',')`.
 */
export function parseCsv(text: string): string[][] {
  // BOM de Excel al guardar "CSV UTF-8".
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let touched = false;

  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; touched = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; touched = true; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; touched = false; i++; continue; }
    field += ch; touched = true; i++;
  }
  if (touched || field || row.length) { row.push(field); rows.push(row); }

  // Se descartan las filas totalmente vacías (líneas en blanco al final del archivo).
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Corta al máximo de filas de datos permitido por importación (sin contar el encabezado). */
export const IMPORT_MAX_ROWS = 5000;
