import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, Zap } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useMeta } from '../../lib/meta';
import { useFmt } from '../../lib/useFmt';
import { Badge, Button, Field, Input, Modal, PageHeader, Select, Textarea, useErr, useToast } from '../../components/ui';
import { useAllRows } from '../../lib/useAllRows';
import { DataGrid, type Filter, type GridColumn } from '../../components/grid/DataGrid';
import { useCatalogOpts } from '../../components/grid/helpers';
import { StatusBadge } from '../../components/fields';

interface OrderRow { id: number; code: string; statusId: number; statusKey: string; customerName: string | null; isQuick: boolean; sellerName: string | null; currency: string; reservedUntil: string | null; createdAt: string; itemCount: number; lineCount: number; total: number | null }

export default function OrdersPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const meta = useMeta();
  const f = useFmt();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const list = useAllRows<OrderRow>(['orders'], '/orders');
  const statusOpts = useCatalogOpts('order_status');
  const statusKey = sp.get('statusKey') ?? '';
  const initial = useMemo<Record<string, Filter>>(() => {
    const id = statusKey ? meta.sysId('order_status', statusKey) : undefined;
    const r: Record<string, Filter> = {};
    if (id) r.status = { op: 'in', list: [String(id)] };
    return r;
  }, [statusKey, meta]);
  const hasTotals = (list.data ?? []).some((o) => o.total !== null);

  const columns: GridColumn<OrderRow>[] = [
    { key: 'code', title: t('common.code'), width: 200, render: (o) => <span className="row gap-sm"><Link to={`/orders/${o.id}`} className="mono" onClick={(e) => e.stopPropagation()}><strong>{o.code}</strong></Link>{o.isQuick && <Badge tone="info"><Zap size={11} /> {t('orders.quick.badge')}</Badge>}</span> },
    { key: 'customer', title: t('orders.customer'), type: 'select', value: (o) => o.customerName ?? (o.isQuick ? t('orders.quick.no_customer_label') : null),
      render: (o) => (o.customerName ?? <span className="muted">{o.isQuick ? t('orders.quick.no_customer_label') : '—'}</span>) },
    { key: 'seller', title: t('orders.seller'), type: 'select', value: (o) => o.sellerName },
    { key: 'status', title: t('common.status'), type: 'select', options: statusOpts, width: 140, value: (o) => String(o.statusId), render: (o) => <StatusBadge id={o.statusId} /> },
    { key: 'itemCount', title: t('orders.units'), type: 'number', width: 100 },
    ...(hasTotals ? [{ key: 'total', title: t('common.total_label'), type: 'money' as const, width: 130, render: (o: OrderRow) => (o.total === null ? '' : f.money(o.total, o.currency)) }] : []),
    { key: 'currency', title: t('orders.currency'), type: 'select' as const, hidden: true, width: 90 },
    { key: 'reservedUntil', title: t('orders.reserved_until'), type: 'datetime', width: 160, value: (o) => (o.statusKey === 'open' ? o.reservedUntil : null) },
    { key: 'createdAt', title: t('common.date'), type: 'date', width: 130 },
  ];

  return (
    <>
      <PageHeader title={t('orders.title')} subtitle={t('orders.subtitle')} actions={can('sales.create') && (
        <div className="row gap-sm">
          {can('sales.complete') && <Button icon={<Zap size={16} />} onClick={() => nav('/orders/quick')}>{t('orders.quick.button')}</Button>}
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>{t('orders.new')}</Button>
        </div>)} />
      <DataGrid id="orders" rows={list.data ?? []} loading={list.isLoading} columns={columns} rowId={(o) => o.id} onRowClick={(o) => nav(`/orders/${o.id}`)}
        initialFilters={initial} initialFiltersKey={statusKey} exportName={t('orders.title')} emptyTitle={t('orders.empty')} valueKey={hasTotals} />
      {creating && <OrderHeaderModal onClose={() => setCreating(false)} onSaved={(id) => nav(`/orders/${id}`)} />}
    </>
  );
}

/** Alta de pedido, o edición de cliente / vendedor / notas / vencimiento de la reserva si se pasa `order`. */
export function OrderHeaderModal({ order, onClose, onSaved }: {
  order?: { id: number; customerId: number | null; sellerId: number | null; notes: string | null; reservedUntil: string | null };
  onClose: () => void; onSaved: (id: number) => void;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const err = useErr();
  const toast = useToast();
  const customers = useQuery({ queryKey: ['customers', 'all'], queryFn: () => api.get<{ items: { id: number; name: string }[] }>('/customers?all=1'), enabled: can('customers.view') });
  const sellers = useQuery({ queryKey: ['sellers', 'all'], queryFn: () => api.get<{ items: { id: number; name: string }[] }>('/sellers?all=1'), enabled: can('sellers.view') });
  const [customerId, setCustomerId] = useState(order?.customerId ? String(order.customerId) : '');
  const [sellerId, setSellerId] = useState(order?.sellerId ? String(order.sellerId) : '');
  const [notes, setNotes] = useState(order?.notes ?? '');
  const toLocal = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  const [until, setUntil] = useState(toLocal(order?.reservedUntil ?? null));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const body = { customerId: Number(customerId), sellerId: sellerId ? Number(sellerId) : null, notes: notes.trim() || null, reservedUntil: until ? new Date(until).toISOString() : null };
      if (order) { await api.patch(`/orders/${order.id}`, body); toast.success(t('common.saved')); onSaved(order.id); }
      else { const r = await api.post<{ id: number }>('/orders', body); toast.success(t('orders.created')); onSaved(r.id); }
      onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} size="md" title={order ? t('orders.edit') : t('orders.new')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={!customerId} onClick={save}>{t('common.save')}</Button></>}>
      <div className="stack">
        <Field label={t('orders.customer')} required>
          <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)} autoFocus>
            <option value="">{t('common.select')}</option>{customers.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label={t('orders.seller')}>
          <Select value={sellerId} onChange={(e) => setSellerId(e.target.value)}>
            <option value="">—</option>{sellers.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label={t('orders.reserved_until')} hint={t('orders.reserved_until_hint')}><Input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} /></Field>
        <Field label={t('common.notes')}><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
