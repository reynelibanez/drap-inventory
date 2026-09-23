/** Exportación de tablas: Excel (.xlsx real, generado en el navegador), CSV y PDF (impresión). */
import { zipSync, strToU8 } from 'fflate';
import { getDocLang, toDoc } from '../../lib/docTrace';
import type { ColType } from './filters';

export type Cell = string | number | boolean | Date | null | undefined;

export interface ExportTable {
  title: string;
  /** Nombre de la hoja de Excel. */
  sheetName?: string;
  /** Líneas encima de la tabla (ej. datos del pedido): cada fila es una lista de celdas. */
  preamble?: { cells: Cell[]; bold?: boolean }[];
  header: string[];
  types: ColType[];
  rows: Cell[][];
  /** Fila final de totales (opcional). */
  totals?: Cell[];
  subtitle?: string;
  landscape?: boolean;
}

const p2 = (n: number) => String(n).padStart(2, '0');
const isDate = (t: ColType) => t === 'date' || t === 'datetime';

// ---------------------------------------------------------------- texto
export function cellToText(c: Cell, type: ColType, lang: string, forCsv = false): string {
  if (c === null || c === undefined) return '';
  if (c instanceof Date) {
    if (Number.isNaN(c.getTime())) return '';
    const d = `${c.getFullYear()}-${p2(c.getMonth() + 1)}-${p2(c.getDate())}`;
    return type === 'datetime' ? `${d} ${p2(c.getHours())}:${p2(c.getMinutes())}` : d;
  }
  if (typeof c === 'number') {
    const decimals = type === 'money' ? 2 : undefined;
    const loc = lang === 'en' ? 'en-US' : 'es-ES';
    if (forCsv) {
      const s = decimals ? c.toFixed(decimals) : String(c);
      return lang === 'en' ? s : s.replace('.', ',');
    }
    return c.toLocaleString(loc, decimals ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 6 });
  }
  if (typeof c === 'boolean') return c ? (lang === 'en' ? 'Yes' : 'Sí') : lang === 'en' ? 'No' : 'No';
  return c;
}

// ---------------------------------------------------------------- descarga
export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export const safeFileName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_').slice(0, 80) || 'export';
export const stamp = () => { const d = new Date(); return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`; };

// ---------------------------------------------------------------- CSV
export function exportCsv(t: ExportTable, filename: string, lang: string) {
  const sep = lang === 'en' ? ',' : ';';
  const esc = (s: string) => (/[";\n\r,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines: string[] = [];
  for (const p of t.preamble ?? []) lines.push(p.cells.map((c) => esc(cellToText(c, 'text', lang, true))).join(sep));
  if (t.preamble?.length) lines.push('');
  lines.push(t.header.map(esc).join(sep));
  for (const r of t.rows) lines.push(r.map((c, i) => esc(cellToText(c, t.types[i] ?? 'text', lang, true))).join(sep));
  if (t.totals) lines.push(t.totals.map((c, i) => esc(cellToText(c, t.types[i] ?? 'text', lang, true))).join(sep));
  downloadBlob(`${filename}.csv`, new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
}

// ---------------------------------------------------------------- XLSX
const xmlEsc = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i: number) => { let n = i + 1, s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const serial = (d: Date) => (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) - Date.UTC(1899, 11, 30)) / 86_400_000;

// Estilos: 0 normal · 1 encabezado · 2 entero · 3 dinero · 4 fecha · 5 fecha y hora · 6 negrita · 7 título
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7ECF1"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF94A3B8"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cellXml(ref: string, c: Cell, type: ColType, style?: number): string {
  if (c === null || c === undefined || c === '') return style !== undefined && style !== 0 ? `<c r="${ref}" s="${style}"/>` : '';
  if (c instanceof Date) {
    if (Number.isNaN(c.getTime())) return '';
    return `<c r="${ref}" s="${type === 'date' ? 4 : 5}"><v>${serial(c)}</v></c>`;
  }
  if (typeof c === 'number') {
    if (!Number.isFinite(c)) return '';
    const s = style ?? (type === 'money' ? 3 : type === 'number' && Number.isInteger(c) ? 2 : 0);
    return `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${c}</v></c>`;
  }
  const text = typeof c === 'boolean' ? (c ? 'Sí' : 'No') : c;
  return `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(text)}</t></is></c>`;
}

const sheetName = (s: string) => s.replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Datos';

export function buildXlsx(t: ExportTable): Uint8Array {
  const name = sheetName(t.sheetName ?? t.title);
  const nCols = t.header.length;
  const rowsXml: string[] = [];
  let r = 1;
  for (const p of t.preamble ?? []) {
    const cells = p.cells.map((c, i) => cellXml(`${colName(i)}${r}`, c, 'text', p.bold ? (r === 1 ? 7 : 6) : undefined)).join('');
    rowsXml.push(`<row r="${r}">${cells}</row>`);
    r++;
  }
  if (t.preamble?.length) { rowsXml.push(`<row r="${r}"/>`); r++; }
  const headerRow = r;
  rowsXml.push(`<row r="${r}">${t.header.map((h, i) => cellXml(`${colName(i)}${r}`, h, 'text', 1)).join('')}</row>`);
  r++;
  for (const row of t.rows) {
    rowsXml.push(`<row r="${r}">${row.map((c, i) => cellXml(`${colName(i)}${r}`, c, t.types[i] ?? 'text')).join('')}</row>`);
    r++;
  }
  const lastDataRow = r - 1;
  if (t.totals) {
    rowsXml.push(`<row r="${r}">${t.totals.map((c, i) => cellXml(`${colName(i)}${r}`, c, t.types[i] ?? 'text', typeof c === 'number' ? undefined : 6)).join('')}</row>`);
    r++;
  }

  // anchos según el contenido
  const widths = t.header.map((h, i) => {
    let m = h.length;
    for (let k = 0; k < Math.min(t.rows.length, 400); k++) {
      const c = t.rows[k]![i];
      const len = c instanceof Date ? 16 : typeof c === 'string' ? c.length : c === null || c === undefined ? 0 : String(c).length + 2;
      if (len > m) m = len;
    }
    return Math.min(60, Math.max(9, m + 2));
  });
  const cols = `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
  const ref = `A${headerRow}:${colName(Math.max(0, nCols - 1))}${Math.max(headerRow, lastDataRow)}`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rowsXml.join('')}</sheetData><autoFilter ref="${ref}"/><pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/></worksheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(name)}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${xmlEsc(name)}'!$A$${headerRow}:$${colName(Math.max(0, nCols - 1))}$${Math.max(headerRow, lastDataRow)}</definedName></definedNames></workbook>`;
  return zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(STYLES),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  });
}

export function exportXlsx(t: ExportTable, filename: string) {
  const bytes = buildXlsx(t);
  downloadBlob(`${filename}.xlsx`, new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
}

// ---------------------------------------------------------------- PDF / imprimir
const htmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function exportPrint(t: ExportTable, lang: string) {
  const right = t.types.map((x) => x === 'number' || x === 'money');
  const body = t.rows.map((r) => `<tr>${r.map((c, i) => `<td${right[i] ? ' class="r"' : ''}>${htmlEsc(cellToText(c, t.types[i] ?? 'text', lang))}</td>`).join('')}</tr>`).join('');
  const foot = t.totals ? `<tfoot><tr>${t.totals.map((c, i) => `<td class="${right[i] ? 'r ' : ''}b">${htmlEsc(cellToText(c, t.types[i] ?? 'text', lang))}</td>`).join('')}</tr></tfoot>` : '';
  const pre = (t.preamble ?? []).map((p) => `<div class="pre${p.bold ? ' b' : ''}">${p.cells.map((c) => htmlEsc(cellToText(c, 'text', lang))).join(' &nbsp; ')}</div>`).join('');
  const landscape = t.landscape ?? t.header.length > 6;
  const now = new Date().toLocaleString(lang === 'en' ? 'en-US' : 'es-ES');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${htmlEsc(t.title)}</title><style>
@page { size: ${landscape ? 'landscape' : 'portrait'}; margin: 12mm; }
body { font: 11px/1.35 system-ui, 'Segoe UI', Arial, sans-serif; color: #111; margin: 0; }
h1 { font-size: 16px; margin: 0 0 2px; } .sub { color: #555; margin-bottom: 10px; } .pre { margin: 1px 0; } .b { font-weight: 700; }
table { width: 100%; border-collapse: collapse; } th { background: #e7ecf1; text-align: left; border-bottom: 1.5px solid #64748b; padding: 4px 6px; }
td { padding: 3px 6px; border-bottom: 1px solid #d5dde5; vertical-align: top; } .r { text-align: right; } tr { break-inside: avoid; } thead { display: table-header-group; }
tfoot td { border-top: 1.5px solid #64748b; }
</style></head><body><h1>${htmlEsc(t.title)}</h1><div class="sub">${htmlEsc(t.subtitle ?? '')} ${htmlEsc(now)}</div>${pre}${pre ? '<div style="height:8px"></div>' : ''}
<table><thead><tr>${t.header.map((h, i) => `<th${right[i] ? ' class="r"' : ''}>${htmlEsc(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody>${foot}</table></body></html>`;
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open(); doc.write(html); doc.close();
  const go = () => { try { frame.contentWindow!.focus(); frame.contentWindow!.print(); } finally { setTimeout(() => frame.remove(), 60_000); } };
  if (doc.readyState === 'complete') setTimeout(go, 50); else frame.onload = () => setTimeout(go, 50);
}

/** La tabla con todos sus textos en el idioma de la empresa (títulos, encabezados, valores de catálogo, totales). */
export function toDocTable(t: ExportTable): ExportTable {
  const cell = (c: Cell): Cell => (typeof c === 'string' ? toDoc(c) : c);
  return {
    ...t,
    title: toDoc(t.title),
    sheetName: t.sheetName ? toDoc(t.sheetName) : t.sheetName,
    subtitle: t.subtitle ? toDoc(t.subtitle) : t.subtitle,
    preamble: t.preamble?.map((p) => ({ ...p, cells: p.cells.map(cell) })),
    header: t.header.map((h) => toDoc(h)),
    rows: t.rows.map((r) => r.map(cell)),
    totals: t.totals?.map(cell),
  };
}

export type ExportKind = 'xlsx' | 'csv' | 'pdf';
/** Exporta o imprime siempre en el idioma de la empresa (textos, fechas, números y separadores), sin importar el idioma en pantalla. */
export function runExport(kind: ExportKind, table: ExportTable, filename: string) {
  const lang = getDocLang();
  const t = toDocTable(table);
  if (kind === 'xlsx') exportXlsx(t, filename);
  else if (kind === 'csv') exportCsv(t, filename, lang);
  else exportPrint(t, lang);
}
export { isDate };
