import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makeCompany, metaHelper, startApi, stopApi, type Api } from './helpers.js';

let api: Api;
let tok: string;
let m: ReturnType<typeof metaHelper>;

// Mismo orden de columnas que la plantilla real de "control técnico" (la columna de tipo de equipo, índice 7,
// no tiene encabezado: así viene en el archivo real).
const HEADERS = [
  'DATE', 'TECH', 'LOTE', 'REF ', 'SERIAL', 'BRAND', 'Model', ' ', 'Processor', 'RAM', 'HDD', 'TIPO DISK', 'LCD SIZE',
  'COSMETIC', 'NOTES', 'NOTE 2', 'COO', 'DESCRIPCION', 'BAR CODE', 'TIME', 'TIPO PRO-GEN', 'PRO-GEN-RAM-DISK', 'SIZE',
  'WIN', 'DESCRIPTION PACKING', 'FUNCTIONAL GRADE', 'TOUCH',
];

interface RowSpec {
  date?: string; lote: string; ref?: string; serial?: string; brand?: string; model?: string; type?: string;
  processor?: string; ram?: string; hdd?: string; diskType?: string; lcdSize?: string; cosmetic?: string;
  notes?: string; notes2?: string; barcode?: string; size?: string; win?: string; functionalGrade?: string; touch?: string;
}

function row(r: RowSpec): string {
  const cols = new Array(27).fill('');
  cols[0] = r.date ?? '9/1/2026'; cols[2] = r.lote; cols[3] = r.ref ?? ''; cols[4] = r.serial ?? ''; cols[5] = r.brand ?? '';
  cols[6] = r.model ?? ''; cols[7] = r.type ?? ''; cols[8] = r.processor ?? ''; cols[9] = r.ram ?? ''; cols[10] = r.hdd ?? '';
  cols[11] = r.diskType ?? ''; cols[12] = r.lcdSize ?? ''; cols[13] = r.cosmetic ?? ''; cols[14] = r.notes ?? '';
  cols[15] = r.notes2 ?? ''; cols[18] = r.barcode ?? ''; cols[22] = r.size ?? ''; cols[23] = r.win ?? '';
  cols[25] = r.functionalGrade ?? ''; cols[26] = r.touch ?? '';
  return cols.join(',');
}

function csvOf(rows: RowSpec[]): string {
  return [HEADERS.join(','), ...rows.map(row)].join('\n');
}

const ROWS: RowSpec[] = [
  // Lote L1: laptop, tres variantes de escritorio (Micro / SFF / Torre / Todo en uno), un accesorio (tipo en blanco),
  // un equipo que no enciende (grado funcional F: debe quedar "No vendible"), grados inválidos, y sin RAM/disco.
  { lote: 'L1', ref: 'REFA', serial: 'SNL001', brand: 'DELL', model: 'LATITUDE 5420', type: 'LAPTOP', processor: 'I7-1185G7', ram: '16GB', hdd: '512GB', diskType: 'NVME', lcdSize: "14''", cosmetic: 'A', barcode: 'BC001', win: 'WIN 11', functionalGrade: 'A', touch: 'NO' },
  { lote: 'L1', ref: 'REFA', serial: 'SNL002', brand: 'LENOVO', model: 'THINKCENTRE M910Q', type: 'MICRO', processor: 'I5-7500T', ram: '8GB', hdd: '256GB', diskType: 'SSD', cosmetic: 'B', barcode: 'BC002', functionalGrade: 'A' },
  { lote: 'L1', ref: 'REFA', serial: 'SNL003', brand: 'HP', model: 'COMPAQ ELITE 8300', type: 'PC SFF', processor: 'I5-3470', ram: '8GB', hdd: '256GB', diskType: 'SSD', cosmetic: 'A', barcode: 'BC003', functionalGrade: 'A' },
  { lote: 'L1', ref: 'REFA', serial: 'SNL004', brand: 'DELL', model: 'OPTIPLEX 7020', type: 'TOWER', processor: 'I5-4570', ram: '8GB', hdd: '500GB', diskType: 'HDD', cosmetic: 'B', barcode: 'BC004', functionalGrade: 'B' },
  { lote: 'L1', ref: 'REFA', serial: 'SNL005', brand: 'HP', model: 'PRODESK 600 AIO', type: 'AIO', processor: 'I5-6500', ram: '8GB', hdd: '256GB', diskType: 'SSD', cosmetic: 'A', barcode: 'BC005', functionalGrade: 'A' },
  { lote: 'L1', ref: 'REFA', notes: 'POWER SUPPLY DELL 90W', cosmetic: 'A', barcode: 'BC006', functionalGrade: 'A' },
  { lote: 'L1', ref: 'REFA', serial: 'SNL007', brand: 'DELL', model: 'LATITUDE 3420', type: 'LAPTOP', processor: 'I5-1135G7', ram: '8GB', hdd: '256GB', diskType: 'NVME', cosmetic: 'C', barcode: 'BC007', win: 'WIN 10', functionalGrade: 'F' },
  { lote: 'L1', ref: 'REFA', serial: 'SNL008', brand: 'DELL', model: 'LATITUDE 5300', type: 'LAPTOP', processor: 'I5-8365U', ram: '8GB', hdd: '256GB', diskType: 'NVME', cosmetic: 'COSMETIC', barcode: 'BC008', functionalGrade: 'D' },
  { lote: 'L1', ref: 'REFA', serial: 'SNL009', brand: 'DELL', model: 'LATITUDE 7390', type: 'LAPTOP', processor: 'I5-8350U', ram: 'NO RAM', hdd: 'NO DISK', diskType: '--', cosmetic: 'B', barcode: 'BC009', functionalGrade: 'A', notes: 'Sin RAM y sin disco' },
  // Fila prácticamente vacía (sobrante del Excel): se omite.
  { lote: 'L1', ref: 'REFA', touch: 'NO' },
  // Lote L2: otro lote físico distinto, con su propia referencia.
  { lote: 'L2', ref: 'REFB', serial: 'SNL2-001', brand: 'ACER', model: 'ASPIRE 5', type: 'LAPTOP', processor: 'I3-1005G1', ram: '4GB', hdd: '128GB', diskType: 'SSD', cosmetic: 'A', barcode: 'BC010', functionalGrade: 'A' },
  // Serie repetida (misma que la primera fila): debe omitirse por duplicado.
  { lote: 'L2', ref: 'REFB', serial: 'SNL001', brand: 'ACER', model: 'ASPIRE 3', type: 'LAPTOP', processor: 'I3-1005G1', ram: '4GB', hdd: '128GB', diskType: 'SSD', cosmetic: 'A', barcode: 'BC011', functionalGrade: 'A' },
];
const CSV = csvOf(ROWS);

beforeAll(async () => {
  api = await startApi();
  await makeCompany('Refurb Tech Import', 'adminTechImport');
  tok = (await login(api, 'adminTechImport')).token;
  const meta = await api.call('GET', '/api/meta', tok);
  m = metaHelper(meta.body);
});
afterAll(() => stopApi(api));

describe('/api/imports/tech: importación independiente de la plantilla de control técnico', () => {
  it('sin sesión, se rechaza', async () => {
    const r = await api.call('POST', '/api/imports/tech/inspect', null, { csv: CSV });
    expect(r.status).toBe(401);
  });

  it('inspecciona el archivo: agrupa por LOTE y saca su referencia', async () => {
    const r = await api.call('POST', '/api/imports/tech/inspect', tok, { csv: CSV });
    expect(r.status).toBe(200);
    expect(r.body.rowCount).toBe(ROWS.length);
    expect(r.body.lots).toEqual(expect.arrayContaining([
      expect.objectContaining({ lote: 'L1', reference: 'REFA', rowCount: 10 }),
      expect.objectContaining({ lote: 'L2', reference: 'REFB', rowCount: 2 }),
    ]));
  });

  it('un archivo sin la forma esperada (falta una columna clave) se rechaza con un error claro', async () => {
    const badHeaders = HEADERS.filter((h) => h !== 'TIPO DISK');
    const badCsv = [badHeaders.join(','), row(ROWS[0])].join('\n');
    const r = await api.call('POST', '/api/imports/tech/inspect', tok, { csv: badCsv });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('tech_import_unrecognized_format');
  });

  it('la vista previa no deja nada guardado', async () => {
    const before = await api.call('GET', '/api/lots?pageSize=200', tok);
    const r = await api.call('POST', '/api/imports/tech/preview', tok, { csv: CSV });
    expect(r.status).toBe(200);
    expect(r.body.preview).toBe(true);
    expect(r.body.lots).toHaveLength(2);
    const after = await api.call('GET', '/api/lots?pageSize=200', tok);
    expect(after.body.total).toBe(before.body.total);
  });

  it('confirma: crea un lote por cada LOTE del archivo, con el tipo correcto por fila', async () => {
    const r = await api.call('POST', '/api/imports/tech/commit', tok, { csv: CSV });
    expect(r.status).toBe(200);
    expect(r.body.preview).toBe(false);
    expect(r.body.lots).toHaveLength(2);

    const lotL1 = r.body.lots.find((l: any) => l.lote === 'L1');
    const lotL2 = r.body.lots.find((l: any) => l.lote === 'L2');
    expect(lotL1.created).toBe(9); // 10 filas - 1 fila vacía omitida
    expect(lotL1.skipped).toBe(1);
    expect(lotL2.created).toBe(1); // 2 filas - 1 serie duplicada
    expect(lotL2.skipped).toBe(1);
    expect(r.body.created).toBe(10);
    expect(r.body.skipped).toBe(2);
    expect(r.body.gradeWarnings).toBe(1); // la fila SNL008 (grado cosmético y funcional inválidos, se cuenta una vez por fila)

    const lotA = await api.call('GET', `/api/lots/${lotL1.lotId}`, tok);
    expect(lotA.body.reference).toBe('REFA');
    expect(lotA.body.statusKey).toBe('counted');
    expect(lotA.body.requiresTesting).toBe(false);
    const lotB = await api.call('GET', `/api/lots/${lotL2.lotId}`, tok);
    expect(lotB.body.reference).toBe('REFB');

    const unitsA = (await api.call('GET', `/api/units?lotId=${lotL1.lotId}&pageSize=50`, tok)).body.items;
    expect(unitsA).toHaveLength(9);

    const meta2 = (await api.call('GET', '/api/meta', tok)).body;
    const mm = metaHelper(meta2);
    const nameOf = (catalogKey: string, id: number) => meta2.catalogs.find((c: any) => c.key === catalogKey)?.items.find((i: any) => i.id === id)?.name.es;

    // Laptop: se resolvió como tipo Laptop, con el tamaño de pantalla, el sistema operativo y el procesador correctos.
    const laptop = unitsA.find((u: any) => u.serialNumber === 'SNL001');
    expect(laptop.equipmentTypeId).toBe(mm.type('laptop'));
    expect(nameOf('brand', laptop.specs.brand)).toBe('Dell');
    expect(nameOf('processor', laptop.specs.processor)).toBe('Intel Core i7');
    expect(nameOf('os', laptop.specs.os)).toBe('Windows 11');
    expect(laptop.specs.screen_size).toBeTruthy();
    expect(laptop.cosmeticGradeId).toBeTruthy();
    expect(laptop.functionalGradeId).toBeTruthy();
    expect(laptop.statusKey).toBe('available');

    // Micro / SFF / Torre / Todo en uno: los cuatro se resolvieron como Computadora de escritorio, con su factor de forma.
    const micro = unitsA.find((u: any) => u.serialNumber === 'SNL002');
    const sff = unitsA.find((u: any) => u.serialNumber === 'SNL003');
    const tower = unitsA.find((u: any) => u.serialNumber === 'SNL004');
    const aio = unitsA.find((u: any) => u.serialNumber === 'SNL005');
    for (const u of [micro, sff, tower, aio]) expect(u.equipmentTypeId).toBe(mm.type('desktop'));
    expect(nameOf('form_factor', micro.specs.form_factor)).toBe('Micro');
    expect(nameOf('form_factor', sff.specs.form_factor)).toBe('SFF (formato reducido)');
    expect(nameOf('form_factor', tower.specs.form_factor)).toBe('Torre');
    expect(nameOf('form_factor', aio.specs.form_factor)).toBe('Todo en uno');

    // Accesorio sin tipo reconocido: cae en Genérico, con la descripción tomada de las notas.
    const accessory = unitsA.find((u: any) => u.notes?.includes('POWER SUPPLY DELL 90W'));
    expect(accessory).toBeTruthy();
    expect(accessory.equipmentTypeId).toBe(mm.type('generic'));
    expect(accessory.specs.description).toBe('POWER SUPPLY DELL 90W');
    expect(accessory.serialNumber).toBeNull();

    // Grado funcional F ("no funciona", no vendible): el equipo queda "No vendible", no "Disponible".
    const broken = unitsA.find((u: any) => u.serialNumber === 'SNL007');
    expect(nameOf('functional_grade', broken.functionalGradeId)).toBe('No funciona');
    expect(broken.statusKey).toBe('not_sellable');

    // Grados con un valor que no coincide con ningún código válido ("COSMETIC" tipeado, "D" no es grado funcional):
    // no se inventan ni bloquean la fila, quedan sin ese grado y anotados en las notas.
    const badGrades = unitsA.find((u: any) => u.serialNumber === 'SNL008');
    expect(badGrades.cosmeticGradeId).toBeFalsy();
    expect(badGrades.functionalGradeId).toBeFalsy();
    expect(badGrades.notes).toContain('Grado cosmético "COSMETIC" no reconocido');
    expect(badGrades.notes).toContain('Grado funcional "D" no reconocido');
    expect(badGrades.statusKey).toBe('available'); // sin grado funcional inválido no se marca "no vendible" por las dudas

    // "NO RAM" / "NO DISK" / "--": no generan valores inventados en los catálogos.
    const noRamDisk = unitsA.find((u: any) => u.serialNumber === 'SNL009');
    expect(noRamDisk.specs.ram).toBeUndefined();
    expect(noRamDisk.specs.storage_size).toBeUndefined();
    expect(noRamDisk.specs.storage_type).toBeUndefined();

    // Segundo lote con su propia referencia; la serie repetida del primer lote se omitió.
    const unitsB = (await api.call('GET', `/api/units?lotId=${lotL2.lotId}&pageSize=50`, tok)).body.items;
    expect(unitsB).toHaveLength(1);
    expect(unitsB[0].serialNumber).toBe('SNL2-001');
    const dupRow = r.body.results.find((row: any) => row.reason === 'serial_duplicate');
    expect(dupRow).toBeTruthy();
  });
});
