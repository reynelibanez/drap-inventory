import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ClipboardPaste, Plus, ScanLine, Trash2, Zap } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { pasteText } from '../../lib/clipboard';
import { useMeta, type Specs } from '../../lib/meta';
import { Alert } from '../../components/Alert';
import { Button, Card, Field, Input, ItemBadge, PageHeader, Select, Textarea, useConfirm, useErr, useToast } from '../../components/ui';
import { SpecChips, TypeLabel } from '../../components/fields';
import { DataGrid, type GridColumn } from '../../components/grid/DataGrid';
import { useTypeOpts } from '../../components/grid/helpers';

interface QUnit {
  id: number; code: string; serialNumber: string | null; specs: Specs; equipmentTypeId: number;
  cosmeticGradeId: number | null; functionalGradeId: number | null; lotCode: string; slotCode: string | null;
}
interface CheckResult { input: string; outcome: 'ok' | 'not_found' | 'not_available' | 'duplicate'; code?: string; status?: string; unit?: QUnit }
interface Problem { input: string; text: string }

/** Separa códigos escritos, escaneados o pegados (uno por línea, o separados por espacios, comas o punto y coma). */
const splitCodes = (s: string) => s.split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean);

/**
 * Venta rápida: se venden equipos sin crear un pedido. Solo se agregan los equipos (escaneando, escribiendo
 * o pegando códigos); el cliente, las notas y el precio son opcionales.
 */
export default function QuickSalePage() {
  const { t } = useTranslation();
  const meta = useMeta();
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const err = useErr();
  const toast = useToast();
  const confirm = useConfirm();
  const location = useLocation();
  const typeOpts = useTypeOpts();
  const box = useRef<HTMLInputElement>(null);
  const [one, setOne] = useState('');
  const [units, setUnits] = useState<QUnit[]>([]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [more, setMore] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [notes, setNotes] = useState('');
  const [price, setPrice] = useState('');
  const customers = useQuery({ queryKey: ['customers', 'all'], queryFn: () => api.get<{ items: { id: number; name: string }[] }>('/customers?all=1'), enabled: can('customers.view') && more });

  const allowed = can('sales.complete') && can('sales.create');
  const have = useMemo(() => new Set(units.map((u) => u.code.toLowerCase())), [units]);

  /** Verifica los códigos en el servidor y agrega a la lista los que se pueden vender. */
  async function add(codes: string[]) {
    const fresh = codes.filter((c) => !have.has(c.toLowerCase()));
    const repeated = codes.length - fresh.length;
    if (!fresh.length) { if (repeated) toast.info(t('orders.quick.already_in_list')); return; }
    setBusy(true);
    try {
      const r = await api.post<{ results: CheckResult[] }>('/quick-sales/check', { codes: fresh });
      const ok = r.results.filter((x) => x.outcome === 'ok' && x.unit).map((x) => x.unit!);
      const bad: Problem[] = r.results.filter((x) => x.outcome !== 'ok').map((x) => ({
        input: x.code ?? x.input,
        text: x.outcome === 'not_found' ? t('orders.pick.not_found')
          : x.outcome === 'duplicate' ? t('orders.pick.duplicate')
          : t('orders.pick.not_available', { status: x.status ? meta.name(meta.sysId('unit_status', x.status)) || x.status : '' }),
      }));
      const seen = new Set(have);
      const fresh2 = ok.filter((u) => !seen.has(u.code.toLowerCase()) && seen.add(u.code.toLowerCase()));
      if (fresh2.length) setUnits((prev) => [...fresh2, ...prev]);
      setProblems(bad);
      if (bad.length) toast.error(t('orders.quick.problems_toast', { count: bad.length }));
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); box.current?.focus(); }
  }

  // Equipos que llegan ya escogidos desde Inventario.
  const initial = (location.state as { codes?: string[] } | null)?.codes;
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (initial?.length) void add(initial); else box.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitOne(e: React.FormEvent) {
    e.preventDefault();
    const codes = splitCodes(one);
    if (!codes.length || busy) return;
    setOne('');
    await add(codes);
  }
  /** Si se pegan varios códigos de una vez (p. ej. copiados de Inventario), se agregan todos. */
  function onPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text');
    const codes = splitCodes(text);
    if (codes.length > 1) { e.preventDefault(); setOne(''); void add(codes); }
  }
  async function pasteFromClipboard() {
    const v = await pasteText();
    if (v === null) { toast.info(t('orders.pick.paste_manual')); box.current?.focus(); return; }
    const codes = splitCodes(v);
    if (codes.length) await add(codes);
  }
  const removeSelected = () => { setUnits((us) => us.filter((u) => !sel.has(u.id))); setSel(new Set()); };

  async function sell() {
    if (!(await confirm({ title: t('orders.quick.confirm_title', { count: units.length }), message: t('orders.quick.confirm_msg'), confirmLabel: t('orders.quick.sell', { count: units.length }) }))) return;
    setSaving(true);
    try {
      const r = await api.post<{ id: number; code: string; count: number }>('/quick-sales', {
        unitIds: units.map((u) => u.id),
        customerId: customerId ? Number(customerId) : null,
        notes: notes.trim() || null,
        unitPrice: can('sales.price') && price !== '' ? Number(price) : null,
      });
      toast.success(t('orders.quick.done', { count: r.count, code: r.code }));
      for (const k of ['units', 'orders', 'dashboard', 'locations']) void qc.invalidateQueries({ queryKey: [k] });
      nav(`/orders/${r.id}`);
    } catch (e) { toast.error(err(e)); } finally { setSaving(false); }
  }

  const columns: GridColumn<QUnit>[] = [
    { key: 'code', title: t('common.code'), width: 150, value: (u) => u.code, render: (u) => <><Link to={`/units/${u.id}`} className="mono" target="_blank"><strong>{u.code}</strong></Link>{u.serialNumber && <div className="sub">S/N {u.serialNumber}</div>}</> },
    { key: 'type', title: t('common.type'), type: 'select', options: typeOpts, width: 150, value: (u) => String(u.equipmentTypeId), render: (u) => <TypeLabel typeId={u.equipmentTypeId} /> },
    { key: 'description', title: t('units.description'), width: 280, value: (u) => meta.describe(u.equipmentTypeId, u.specs).join(' · '), render: (u) => <SpecChips typeId={u.equipmentTypeId} specs={u.specs} /> },
    { key: 'cosmetic', title: t('units.cosmetic'), width: 110, value: (u) => (u.cosmeticGradeId ? meta.name(u.cosmeticGradeId) : null), render: (u) => <ItemBadge id={u.cosmeticGradeId} code /> },
    { key: 'functional', title: t('units.functional'), width: 110, value: (u) => (u.functionalGradeId ? meta.name(u.functionalGradeId) : null), render: (u) => <ItemBadge id={u.functionalGradeId} code /> },
    { key: 'location', title: t('units.location'), width: 150, value: (u) => u.slotCode },
  ];

  if (!allowed) return <Alert kind="warn">{t('orders.quick.no_permission')}</Alert>;
  return (
    <>
      <PageHeader
        back={<Link to="/orders" className="row gap-sm muted" style={{ marginBottom: 6 }}><ArrowLeft size={14} />{t('orders.title')}</Link>}
        title={<span className="row gap-sm"><Zap size={22} />{t('orders.quick.title')}</span>} subtitle={t('orders.quick.subtitle')} />

      <div className="stack">
        <Card title={<span className="row gap-sm"><ScanLine size={18} />{t('orders.quick.add_title')}</span>}>
          <form className="stack" onSubmit={submitOne}>
            <p className="muted">{t('orders.quick.hint')}</p>
            <div className="row gap-sm wrap">
              <Input ref={box} className="mono grow" value={one} onChange={(e) => setOne(e.target.value)} onPaste={onPaste} placeholder={t('orders.pick.placeholder_one')} autoComplete="off" spellCheck={false} style={{ minWidth: 220 }} />
              <Button type="submit" variant="primary" icon={<Plus size={16} />} loading={busy} disabled={!one.trim()}>{t('orders.pick.add_one')}</Button>
              <Button type="button" variant="ghost" icon={<ClipboardPaste size={16} />} onClick={pasteFromClipboard}>{t('orders.pick.paste')}</Button>
            </div>
          </form>
        </Card>

        {problems.length > 0 && (
          <Alert kind="bad">
            <div className="row spread"><strong>{t('orders.quick.problems_title', { count: problems.length })}</strong><Button size="sm" variant="ghost" onClick={() => setProblems([])}>{t('common.close')}</Button></div>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{problems.map((p, i) => <li key={i}><span className="mono">{p.input}</span> — {p.text}</li>)}</ul>
          </Alert>
        )}

        <Card padded={false} title={t('orders.quick.list_title', { count: units.length })}
          actions={sel.size > 0 ? <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={removeSelected}>{t('orders.quick.remove', { count: sel.size })}</Button> : undefined}>
          <DataGrid id="quick-sale" bare rows={units} columns={columns} rowId={(u) => u.id} selectable selected={sel} onSelectedChange={setSel}
            exportName={t('orders.quick.title')} emptyTitle={t('orders.quick.empty')} emptyHint={t('orders.quick.empty_hint')} />
        </Card>

        <Card title={<button type="button" className="btn btn-ghost btn-sm" onClick={() => setMore((m) => !m)}>{more ? '▾' : '▸'} {t('orders.quick.optional')}</button>}>
          {more ? (
            <div className="row wrap" style={{ alignItems: 'flex-start' }}>
              {can('customers.view') && (
                <Field label={t('orders.customer')}>
                  <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)} style={{ minWidth: 240 }}>
                    <option value="">{t('orders.quick.no_customer')}</option>
                    {customers.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </Field>
              )}
              {can('sales.price') && <Field label={t('orders.quick.price_each')} hint={t('pricing.quick_hint')}><Input type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} style={{ width: 150 }} /></Field>}
              <Field label={t('common.notes')} className="grow"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            </div>
          ) : <span className="muted">{t('orders.quick.optional_hint')}</span>}
        </Card>

        <div className="row spread m-col">
          <span className="muted">{t('orders.quick.footer_hint')}</span>
          <Button variant="primary" icon={<Zap size={16} />} loading={saving} disabled={!units.length} onClick={sell}>{t('orders.quick.sell', { count: units.length })}</Button>
        </div>
      </div>
    </>
  );
}
