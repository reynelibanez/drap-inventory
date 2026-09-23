import type { FastifyInstance } from 'fastify';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { AppLanguage } from '../config.js';
import { badRequest, notFound } from '../errors.js';
import { route, zId } from '../http.js';
import { companyLanguage } from '../services/common.js';
import { describeSpecs, itemCode, loadLabelIndex, tr, typeName } from '../services/describe.js';
import { assertOrderVisible } from '../services/salesScope.js';
import { applyAdjustments, parseAdjustments } from './sales.js';

const MM = 72 / 25.4;

function toBuffer(build: (doc: PDFKit.PDFDocument) => void, options: PDFKit.PDFDocumentOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument(options);
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    build(doc);
    doc.end();
  });
}

const T = {
  es: { title: 'LISTA DE EMPAQUE', order: 'Pedido', date: 'Fecha', customer: 'Cliente', seller: 'Vendedor', summary: 'Resumen', desc: 'Descripción',
        qty: 'Cant.', price: 'Precio', amount: 'Importe', detail: 'Detalle de equipos', code: 'Código', serial: 'Serie', grade: 'Grado', lot: 'Lote',
        total: 'Total', subtotal: 'Subtotal', units: 'equipos', notes: 'Notas', contact: 'Contacto', country: 'País' },
  en: { title: 'PACKING LIST', order: 'Order', date: 'Date', customer: 'Customer', seller: 'Seller', summary: 'Summary', desc: 'Description',
        qty: 'Qty', price: 'Price', amount: 'Amount', detail: 'Unit detail', code: 'Code', serial: 'Serial', grade: 'Grade', lot: 'Lot',
        total: 'Total', subtotal: 'Subtotal', units: 'units', notes: 'Notes', contact: 'Contact', country: 'Country' },
} as const;

const money = (n: number, cur: string, lang: AppLanguage) =>
  new Intl.NumberFormat(lang === 'es' ? 'es-US' : 'en-US', { style: 'currency', currency: cur }).format(n);

export async function documentRoutes(app: FastifyInstance) {
  // ---------- Lista de empaque de un pedido ----------
  app.get('/api/orders/:id/packing-list.pdf', route('sales.view', async (c) => {
    const { id } = c.params(z.object({ id: zId }));
    const q = c.query(z.object({ prices: z.enum(['0', '1']).default('1') }));
    const lang = await companyLanguage(c.db, c.companyId);   // los documentos salen en el idioma de la empresa, no en el del usuario
    const t = T[lang];
    const showPrices = q.prices === '1' && c.can('sales.price');
    await assertOrderVisible(c, id);

    const o = await c.db.opt<any>(
      `SELECT o.code, o.currency, o.notes, o.created_at, o.completed_at, cu.name AS customer, cu.contact_name, cu.address, cu.country, cu.email, cu.phone,
              se.name AS seller, co.name AS company, co.legal_name, o.adjustments AS "rawAdjustments"
         FROM sales_orders o LEFT JOIN customers cu ON cu.id = o.customer_id LEFT JOIN sellers se ON se.id = o.seller_id JOIN companies co ON co.id = o.company_id
        WHERE o.id = $1`, [id]);
    if (!o) throw notFound('order_not_found');
    const items = await c.db.rows<any>(
      `SELECT si.unit_price, u.code, u.serial_number, u.specs, u.equipment_type_id, u.cosmetic_grade_id, u.functional_grade_id, l.code AS lot_code
         FROM sale_items si JOIN units u ON u.id = si.unit_id JOIN lots l ON l.id = u.lot_id
        WHERE si.order_id = $1 AND si.released_at IS NULL ORDER BY u.equipment_type_id, u.id`, [id]);
    const idx = await loadLabelIndex(c.db);

    // Agrupa equipos iguales (mismo tipo y mismas especificaciones de línea).
    const groups = new Map<string, { desc: string; qty: number; amount: number; priced: number }>();
    for (const it of items) {
      const parts = describeSpecs(idx, it.equipment_type_id, it.specs, lang, true);
      const desc = [typeName(idx, it.equipment_type_id, lang), ...parts].join(' · ');
      const g = groups.get(desc) ?? groups.set(desc, { desc, qty: 0, amount: 0, priced: 0 }).get(desc)!;
      g.qty++;
      if (it.unit_price !== null) { g.amount += it.unit_price; g.priced++; }
    }
    const subtotal = items.reduce((a, i) => a + (i.unit_price ?? 0), 0);
    const adj = applyAdjustments(subtotal, parseAdjustments(o.rawAdjustments));

    const buf = await toBuffer((doc) => {
      const L = 40, R = doc.page.width - 40, W = R - L;
      doc.fontSize(18).font('Helvetica-Bold').text(o.company, L, 40);
      doc.fontSize(11).font('Helvetica').fillColor('#555').text(o.legal_name ?? '', L, doc.y);
      doc.fillColor('#000').fontSize(16).font('Helvetica-Bold').text(t.title, L, 40, { width: W, align: 'right' });
      doc.fontSize(10).font('Helvetica').text(`${t.order}: ${o.code}`, L, doc.y, { width: W, align: 'right' });
      doc.text(`${t.date}: ${new Date(o.completed_at ?? o.created_at).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US')}`, L, doc.y, { width: W, align: 'right' });

      doc.moveDown(2);
      const y0 = Math.max(doc.y, 110);
      doc.font('Helvetica-Bold').fontSize(10).text(t.customer, L, y0);
      doc.font('Helvetica').text(o.customer ?? '—');
      for (const line of [o.contact_name && `${t.contact}: ${o.contact_name}`, o.address, o.country && `${t.country}: ${o.country}`, o.email, o.phone]) if (line) doc.text(line);
      if (o.seller) doc.font('Helvetica-Bold').text(`${t.seller}: `, L, doc.y + 4, { continued: true }).font('Helvetica').text(o.seller);

      // Resumen
      doc.moveDown(1.5);
      doc.font('Helvetica-Bold').fontSize(11).text(t.summary, L, doc.y);
      doc.moveDown(0.3);
      const colQty = L + W - (showPrices ? 200 : 60), colPrice = L + W - 140, colAmt = L + W - 70;
      const head = (y: number) => {
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#444');
        doc.text(t.desc, L, y); doc.text(t.qty, colQty, y, { width: 50, align: 'right' });
        if (showPrices) { doc.text(t.price, colPrice, y, { width: 60, align: 'right' }); doc.text(t.amount, colAmt, y, { width: 70, align: 'right' }); }
        doc.fillColor('#000').moveTo(L, y + 13).lineTo(R, y + 13).strokeColor('#bbb').stroke();
      };
      head(doc.y);
      doc.y += 18;
      doc.font('Helvetica').fontSize(9);
      for (const g of groups.values()) {
        if (doc.y > doc.page.height - 80) { doc.addPage(); head(40); doc.y = 58; doc.font('Helvetica').fontSize(9); }
        const y = doc.y;
        doc.text(g.desc, L, y, { width: colQty - L - 10 });
        const h = doc.y - y;
        doc.text(String(g.qty), colQty, y, { width: 50, align: 'right' });
        if (showPrices) {
          if (g.priced) {
            doc.text(money(g.amount / g.priced, o.currency, lang), colPrice, y, { width: 60, align: 'right' });
            doc.text(money(g.amount, o.currency, lang), colAmt, y, { width: 70, align: 'right' });
          }
        }
        doc.y = y + Math.max(h, 12) + 4;
      }
      doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#bbb').stroke();
      doc.moveDown(0.4).font('Helvetica-Bold').fontSize(10);
      const ty = doc.y;
      doc.text(`${items.length} ${t.units}`, L, ty);
      if (showPrices) {
        // Subtotal, descuentos/cargos del pedido y total final.
        if (adj.adjustments.length) {
          doc.font('Helvetica').text(`${t.subtotal}: ${money(subtotal, o.currency, lang)}`, L, ty, { width: W, align: 'right' });
          for (const a of adj.adjustments) {
            const label = a.kind === 'percent' ? `${a.label} (${a.value > 0 ? '+' : ''}${a.value}%)` : a.label;
            doc.text(`${label}: ${money(a.amount, o.currency, lang)}`, L, doc.y, { width: W, align: 'right' });
          }
          doc.font('Helvetica-Bold').text(`${t.total}: ${money(adj.total, o.currency, lang)}`, L, doc.y, { width: W, align: 'right' });
        } else doc.text(`${t.total}: ${money(subtotal, o.currency, lang)}`, L, ty, { width: W, align: 'right' });
      }
      if (o.notes) { doc.moveDown(1).font('Helvetica-Bold').text(t.notes, L, doc.y).font('Helvetica').text(o.notes, { width: W }); }

      // Detalle unidad por unidad (con series)
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(11).text(t.detail, L, 40);
      doc.moveDown(0.5);
      // El detalle identifica cada equipo por su número de serie (si no tiene, se muestra su código).
      const cSerial = L, cDesc = L + 190, cGrade = R - 60;
      const dHead = (y: number) => {
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#444');
        doc.text(t.serial, cSerial, y); doc.text(t.desc, cDesc, y); doc.text(t.grade, cGrade, y, { width: 60, align: 'right' });
        doc.fillColor('#000').moveTo(L, y + 11).lineTo(R, y + 11).strokeColor('#bbb').stroke();
      };
      dHead(doc.y);
      doc.y += 15;
      doc.font('Helvetica').fontSize(8);
      for (const it of items) {
        if (doc.y > doc.page.height - 60) { doc.addPage(); dHead(40); doc.y = 55; doc.font('Helvetica').fontSize(8); }
        const y = doc.y;
        const desc = [typeName(idx, it.equipment_type_id, lang), ...describeSpecs(idx, it.equipment_type_id, it.specs, lang, true)].join(' · ');
        doc.text(it.serial_number || it.code, cSerial, y, { width: 180, lineBreak: false });
        doc.text(desc, cDesc, y, { width: cGrade - cDesc - 8, height: 20, ellipsis: true });
        doc.text([itemCode(idx, it.cosmetic_grade_id), itemCode(idx, it.functional_grade_id)].filter(Boolean).join('/'), cGrade, y, { width: 60, align: 'right', lineBreak: false });
        doc.y = y + 13;
      }
    }, { size: 'A4', margin: 40, bufferPages: false, info: { Title: `${t.title} ${o.code}` } });

    c.reply.type('application/pdf').header('content-disposition', `inline; filename="${o.code}.pdf"`);
    return buf;
  }));

  // ---------- Etiquetas con QR ----------
  app.get('/api/units/labels.pdf', route('units.view', async (c) => {
    const q = c.query(z.object({
      ids: z.string().min(1).max(6000),
      size: z.enum(['62x29', '50x30', '100x50']).default('62x29'),
    }));
    const lang = await companyLanguage(c.db, c.companyId);
    const ids = q.ids.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
    if (!ids.length) throw badRequest('invalid_value');
    const units = await c.db.rows<any>(
      `SELECT id, code, serial_number, specs, equipment_type_id, cosmetic_grade_id, functional_grade_id
         FROM units WHERE id = ANY($1::bigint[]) ORDER BY id`, [ids]);
    if (!units.length) throw notFound('unit_not_found');
    const idx = await loadLabelIndex(c.db);
    const [wmm, hmm] = q.size.split('x').map(Number);
    const w = wmm * MM, h = hmm * MM;
    const qrs = await Promise.all(units.map((u) => QRCode.toBuffer(u.code, { margin: 0, width: 300, errorCorrectionLevel: 'M' })));

    const buf = await toBuffer((doc) => {
      units.forEach((u, i) => {
        if (i > 0) doc.addPage({ size: [w, h], margin: 0 });
        const pad = 3 * MM, qr = h - 2 * pad;
        doc.image(qrs[i], pad, pad, { width: qr, height: qr });
        const x = pad + qr + 2.5 * MM, tw = w - x - pad;
        const bigger = hmm >= 40;
        doc.font('Helvetica-Bold').fontSize(bigger ? 16 : 10.5).text(u.code, x, pad, { width: tw, lineBreak: false });
        const parts = describeSpecs(idx, u.equipment_type_id, u.specs, lang, true);
        doc.font('Helvetica').fontSize(bigger ? 9 : 6.5).text([typeName(idx, u.equipment_type_id, lang), ...parts].join(' · '), x, doc.y + 1.5, { width: tw, height: h - 2 * pad - (bigger ? 30 : 22), ellipsis: true });
        const g = [itemCode(idx, u.cosmetic_grade_id), itemCode(idx, u.functional_grade_id)].filter(Boolean).join(' / ');
        doc.font('Helvetica-Bold').fontSize(bigger ? 12 : 8).text(g ? `${lang === 'es' ? 'Grado' : 'Grade'} ${g}` : '', x, h - pad - (bigger ? 14 : 9), { width: tw, lineBreak: false });
        if (u.serial_number && bigger) doc.font('Helvetica').fontSize(8).text(`S/N ${u.serial_number}`, x, h - pad - 26, { width: tw, lineBreak: false });
      });
    }, { size: [w, h], margin: 0, autoFirstPage: true, info: { Title: 'Labels' } });

    c.reply.type('application/pdf').header('content-disposition', 'inline; filename="labels.pdf"');
    return buf;
  }));
}

export { tr };
