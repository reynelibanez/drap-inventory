import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useMeta, type Specs } from '../../lib/meta';
import { todayISO } from '../../lib/format';
import { Button, Card, Checkbox, Field, Input, PageHeader, Select, Textarea, useErr, useToast } from '../../components/ui';
import { SpecFields, TypeSelect } from '../../components/fields';

interface DraftLine { key: number; typeId: number | null; specs: Specs; qty: string; notes: string }
let keySeq = 1;
const blank = (typeId: number | null = null): DraftLine => ({ key: keySeq++, typeId, specs: {}, qty: '1', notes: '' });

export default function LotNewPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const meta = useMeta();
  const { can, company } = useAuth();
  const err = useErr();
  const toast = useToast();
  const suppliers = useQuery({ queryKey: ['suppliers', 'all'], queryFn: () => api.get<{ items: { id: number; name: string }[] }>('/suppliers?all=1'), enabled: can('suppliers.view') });
  const [supplierId, setSupplierId] = useState('');
  const [date, setDate] = useState(todayISO());
  const [reference, setReference] = useState('');
  const [cost, setCost] = useState('');
  const [notes, setNotes] = useState('');
  const [requiresTesting, setRequiresTesting] = useState(true);
  const [lines, setLines] = useState<DraftLine[]>([blank()]);
  const [busy, setBusy] = useState(false);

  const patch = (key: number, p: Partial<DraftLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const total = lines.reduce((a, l) => a + (Number(l.qty) || 0), 0);

  async function save() {
    const valid = lines.filter((l) => l.typeId);
    setBusy(true);
    try {
      const r = await api.post<{ id: number }>('/lots', {
        supplierId: supplierId ? Number(supplierId) : null, purchaseDate: date, reference: reference || null,
        ...(can('costs.manage') ? { totalCost: cost === '' ? null : Number(cost) } : {}), notes: notes || null, requiresTesting,
        lines: valid.map((l) => ({ equipmentTypeId: l.typeId, specs: l.specs, expectedQty: Math.max(0, Math.floor(Number(l.qty) || 0)), notes: l.notes || null })),
      });
      toast.success(t('lots.created'));
      nav(`/lots/${r.id}`);
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title={t('lots.new')} subtitle={t('lots.new_hint')} />
      <div className="stack">
        <Card title={t('lots.purchase')}>
          <div className="form-grid">
            {can('suppliers.view') && (
              <Field label={t('lots.supplier')}>
                <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  <option value="">—</option>
                  {suppliers.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
            )}
            <Field label={t('lots.purchase_date')}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label={t('lots.reference')} hint={t('lots.reference_hint')}><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
            {can('costs.manage') && <Field label={t('lots.total_cost', { currency: company?.currency })}><Input type="number" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>}
          </div>
          <Field label={t('common.notes')} className="" ><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          <div>
            <Checkbox checked={!requiresTesting} onChange={(v) => setRequiresTesting(!v)} label={t('lots.skip_testing')} />
            <div className="field-hint">{t('lots.skip_testing_hint')}</div>
          </div>
        </Card>

        <Card title={t('lots.lines_title', { count: total })} actions={<Button size="sm" icon={<Plus size={14} />} onClick={() => setLines((l) => [...l, blank(l.at(-1)?.typeId ?? null)])}>{t('lots.add_line')}</Button>}>
          <div className="stack">
            {lines.map((l, i) => (
              <div key={l.key} className="card" style={{ background: 'var(--surface-2)', boxShadow: 'none' }}>
                <div className="card-body stack">
                  <div className="row spread">
                    <strong>{t('lots.line_n', { n: i + 1 })}</strong>
                    <div className="row gap-sm">
                      <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => setLines((ls) => { const c = [...ls]; c.splice(i + 1, 0, { ...l, key: keySeq++, specs: { ...l.specs } }); return c; })}>{t('lots.duplicate')}</Button>
                      {lines.length > 1 && <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={t('common.remove')} />}
                    </div>
                  </div>
                  <div className="grid grid-2">
                    <Field label={t('common.type')}><TypeSelect value={l.typeId} onChange={(v) => patch(l.key, { typeId: v, specs: {} })} /></Field>
                    <Field label={t('lots.expected_qty')}><Input type="number" min={0} value={l.qty} onChange={(e) => patch(l.key, { qty: e.target.value })} /></Field>
                  </div>
                  {l.typeId && (meta.typeAttrs(l.typeId, { lotLine: true }).length > 0) && (
                    <SpecFields typeId={l.typeId} mode="lot" value={l.specs} onChange={(s) => patch(l.key, { specs: s })} />
                  )}
                  <Field label={t('common.notes')}><Input value={l.notes} onChange={(e) => patch(l.key, { notes: e.target.value })} /></Field>
                </div>
              </div>
            ))}
          </div>
        </Card>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={() => nav('/lots')}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} onClick={save}>{t('lots.create_action')}</Button>
        </div>
      </div>
    </>
  );
}
