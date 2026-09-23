import type { CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Ban, Bookmark, CircleCheck, ClipboardCheck, FlaskConical, MapPinOff, ShoppingCart, TrendingUp, UserCheck, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useMeta } from '../lib/meta';
import { useFmt } from '../lib/useFmt';
import { Badge, Card, Empty, PageHeader, Progress, Spinner } from '../components/ui';
import { StatusBadge, TypeLabel } from '../components/fields';
import { EntityLink, useAuditText } from '../components/AuditLine';
import { Bars, CountUp, Donut, HBars, StackedBars, type Slice } from '../components/charts';

interface Day { day: string; n: number }
interface Dash {
  inventory?: {
    unitsByStatus: { statusId: number; n: number }[];
    unitsByType: { typeId: number; statusKey: string; n: number }[];
    byCosmetic: { gradeId: number | null; n: number }[]; byFunctional: { gradeId: number | null; n: number }[];
    aging: { d30: number; d60: number; d90: number; d90p: number };
    testedToday: number; testedByDay: Day[]; testedByTech: { name: string; techNumber: number; n: number }[];
  };
  mine?: { testedByDay: Day[]; inTesting: number };
  locations?: { toPlace: number; occupancy: { id: number; code: string; name: string; capacity: number; used: number }[] };
  lots?: {
    lotsByStatus: { statusId: number; n: number }[];
    openLots: { id: number; code: string; statusKey: string; counted: number; units: number; inTesting: number }[];
    receivedByMonth: { month: string; lots: number; units: number }[];
  };
  sales?: {
    openOrders: { id: number; code: string; customerName: string; reservedUntil: string | null; itemCount: number; requested: number }[]; openCount: number;
    ordersByStatus: { statusId: number; n: number }[]; soldMonth: number; soldByDay: Day[]; topCustomers: { name: string; n: number }[];
    revenueByMonth: { month: string; currency: string; total: number }[] | null; mine: { open: number; units: number } | null;
  };
  recent?: { id: number; at: string; action: string; entity: string; entityId: number | null; data: any; userName: string | null }[];
}

function Kpi({ value, label, to, tone, icon: Icon }: { value: number; label: string; to?: string; tone?: string; icon: LucideIcon }) {
  const f = useFmt();
  const body = (
    <div className="card kpi" style={tone ? ({ '--kpi': tone } as CSSProperties) : undefined}>
      <span className="kpi-icon"><Icon size={18} /></span>
      <span className="kpi-value"><CountUp value={value} format={f.int} /></span>
      <span className="kpi-label">{label}</span>
    </div>
  );
  return to ? <Link to={to} className="kpi-link">{body}</Link> : body;
}

const shortDay = (d: string) => `${Number(d.slice(8, 10))}/${Number(d.slice(5, 7))}`;
/** Últimos 6 meses (incluye los vacíos) para que las barras no salten. */
function lastMonths(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = n - 1; i >= 0; i--) { const x = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`); }
  return out;
}

export default function DashboardPage() {
  const { t, i18n } = useTranslation();
  const meta = useMeta();
  const f = useFmt();
  const { can, user } = useAuth();
  const auditText = useAuditText();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Dash>('/dashboard'), refetchInterval: 60_000 });
  if (q.isLoading || !q.data) return <Spinner />;
  const d = q.data;
  const inv = d.inventory, sales = d.sales, lots = d.lots, loc = d.locations;

  const statusItems = meta.catalogOptions('unit_status');
  const count = (key: string) => inv?.unitsByStatus.find((s) => meta.sysKey(s.statusId) === key)?.n ?? 0;
  const monthName = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString(i18n.language.startsWith('en') ? 'en-US' : 'es-US', { month: 'short' });
  const months = lastMonths(6);
  const cur = meta.data.company.currency;
  const rev = sales?.revenueByMonth ?? null;
  const revCurrency = rev && rev.some((r) => r.currency === cur) ? cur : rev?.[0]?.currency ?? cur;
  const gradeSlices = (rows: { gradeId: number | null; n: number }[]): Slice[] =>
    rows.slice().sort((a, b) => (meta.item(a.gradeId)?.sortOrder ?? 99) - (meta.item(b.gradeId)?.sortOrder ?? 99))
      .map((r) => ({ label: r.gradeId ? meta.nameWithCode(r.gradeId) : t('dashboard.no_grade'), value: r.n, color: meta.color(r.gradeId) ?? '#94a3b8' }));

  const hasKpis = !!inv || !!loc || !!sales || !!d.mine;
  const empty = !inv && !loc && !lots && !sales && !d.mine && !d.recent;

  return (
    <div className="dash">
      <PageHeader title={t('dashboard.hello', { name: user?.fullName.split(' ')[0] })} subtitle={t('dashboard.subtitle')} />

      {empty && <Card><Empty title={t('dashboard.nothing')} hint={t('dashboard.nothing_hint')} /></Card>}

      {hasKpis && (
        <div className="kpi-grid">
          {inv && <Kpi value={count('available')} label={t('dashboard.available')} icon={CircleCheck} to="/units?statusKey=available" tone="var(--good)" />}
          {inv && <Kpi value={count('testing')} label={t('dashboard.testing')} icon={FlaskConical} to="/units?statusKey=testing" tone="var(--warn)" />}
          {inv && <Kpi value={count('reserved')} label={t('dashboard.reserved')} icon={Bookmark} to="/units?statusKey=reserved" tone="var(--info)" />}
          {loc && <Kpi value={loc.toPlace} label={t('dashboard.to_place')} icon={MapPinOff} to="/units?placed=no" />}
          {inv && <Kpi value={inv.testedToday} label={t('dashboard.tested_today')} icon={ClipboardCheck} />}
          {sales && <Kpi value={sales.openCount} label={t('dashboard.open_orders')} icon={ShoppingCart} to="/orders?statusKey=open" />}
          {sales && <Kpi value={sales.soldMonth} label={t('dashboard.sold_month')} icon={TrendingUp} />}
          {inv && <Kpi value={count('not_sellable')} label={t('dashboard.not_sellable')} icon={Ban} to="/units?statusKey=not_sellable" tone="var(--danger)" />}
          {d.mine && !inv && <Kpi value={d.mine.inTesting} label={t('dashboard.my_in_testing')} icon={FlaskConical} tone="var(--warn)" />}
          {sales?.mine && <Kpi value={sales.mine.open} label={t('dashboard.my_open_orders')} icon={UserCheck} tone="var(--info)" />}
          {sales?.mine && <Kpi value={sales.mine.units} label={t('dashboard.my_sold_month')} icon={TrendingUp} tone="var(--good)" />}
        </div>
      )}

      {inv && (<>
        <div className="dash-section">{t('dashboard.sec_inventory')}</div>
        <div className="dash-grid">
          <Card title={t('dashboard.by_status')}>
            {inv.unitsByStatus.length === 0 ? <Empty title={t('dashboard.no_units')} /> : (
              <Donut data={statusItems.map((s) => ({ label: meta.name(s.id), value: inv.unitsByStatus.find((x) => x.statusId === s.id)?.n ?? 0, color: s.color, to: s.systemKey ? `/units?statusKey=${s.systemKey}` : undefined })).filter((x) => x.value > 0)} />
            )}
          </Card>
          <Card title={t('dashboard.by_type')}>
            {inv.unitsByType.length === 0 ? <Empty title={t('dashboard.no_units')} /> : (
              <StackedBars
                legend={statusItems.filter((s) => s.systemKey).map((s) => ({ label: meta.name(s.id), color: s.color ?? '#94a3b8' }))}
                rows={[...new Set(inv.unitsByType.map((r) => r.typeId))].map((typeId) => ({
                  label: <TypeLabel typeId={typeId} />,
                  segments: statusItems.filter((s) => s.systemKey).map((s) => ({ value: inv.unitsByType.find((r) => r.typeId === typeId && r.statusKey === s.systemKey)?.n ?? 0, color: s.color ?? '#94a3b8', title: meta.name(s.id) })),
                }))} />
            )}
          </Card>
          <Card title={t('dashboard.tested_14d')}><Bars data={inv.testedByDay.map((x) => ({ label: shortDay(x.day), value: x.n }))} /></Card>
          <Card title={t('dashboard.cosmetic')}>{inv.byCosmetic.length ? <HBars data={gradeSlices(inv.byCosmetic)} /> : <Empty title={t('dashboard.no_units')} />}</Card>
          <Card title={t('dashboard.functional')}>{inv.byFunctional.length ? <HBars data={gradeSlices(inv.byFunctional)} /> : <Empty title={t('dashboard.no_units')} />}</Card>
          <Card title={t('dashboard.aging')}>
            <Bars height={130} color="var(--info)" data={[
              { label: '0–30', value: inv.aging.d30 }, { label: '31–60', value: inv.aging.d60 }, { label: '61–90', value: inv.aging.d90 }, { label: '90+', value: inv.aging.d90p },
            ]} />
            <p className="muted" style={{ marginTop: 6 }}>{t('dashboard.aging_hint')}</p>
          </Card>
          {inv.testedByTech.length > 0 && <Card title={t('dashboard.tested_by_tech')}><HBars data={inv.testedByTech.map((x) => ({ label: `${x.name} (#${x.techNumber})`, value: x.n }))} /></Card>}
        </div>
      </>)}

      {d.mine && (
        <div className="dash-grid">
          <Card title={t('dashboard.my_testing')}><Bars data={d.mine.testedByDay.map((x) => ({ label: shortDay(x.day), value: x.n }))} color="var(--good)" /></Card>
        </div>
      )}

      {loc && loc.occupancy.length > 0 && (<>
        <div className="dash-section">{t('dashboard.sec_locations')}</div>
        <div className="dash-grid">
          <Card title={t('dashboard.occupancy')}>
            <div className="stack">
              {loc.occupancy.map((w) => {
                const pct = w.capacity ? Math.round((w.used / w.capacity) * 100) : 0;
                return (
                  <div key={w.id}>
                    <div className="row spread"><strong>{w.name}</strong><span className="muted">{w.used} / {w.capacity} · {pct}%</span></div>
                    <Progress value={w.used} max={w.capacity} tone={pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'good'} />
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      </>)}

      {lots && (<>
        <div className="dash-section">{t('dashboard.sec_lots')}</div>
        <div className="dash-grid">
          <Card title={t('dashboard.open_lots')} padded={false} actions={<Link to="/lots">{t('dashboard.see_all')}</Link>}>
            {lots.openLots.length === 0 ? <Empty title={t('dashboard.no_open_lots')} /> : (
              <div className="table-wrap"><table className="table"><tbody>
                {lots.openLots.map((l) => (
                  <tr key={l.id}>
                    <td><Link to={`/lots/${l.id}`} className="mono"><strong>{l.code}</strong></Link><div className="sub"><StatusBadge id={meta.sysId('lot_status', l.statusKey)} /></div></td>
                    <td style={{ width: '45%' }}>
                      <Progress value={l.units} max={Math.max(l.counted, l.units, 1)} tone="good" />
                      <div className="sub">{t('dashboard.lot_progress', { units: l.units, counted: l.counted })}{l.inTesting ? ` · ${t('dashboard.lot_in_testing', { n: l.inTesting })}` : ''}</div>
                    </td>
                  </tr>
                ))}
              </tbody></table></div>
            )}
          </Card>
          <Card title={t('dashboard.lots_month')}>
            <Bars data={months.map((m) => ({ label: monthName(m), value: lots.receivedByMonth.find((x) => x.month === m)?.units ?? 0, title: `${m}: ${lots.receivedByMonth.find((x) => x.month === m)?.lots ?? 0} ${t('dashboard.lots_word')}` }))} color="var(--info)" />
          </Card>
          <Card title={t('dashboard.lots_status')}>
            <Donut data={meta.catalogOptions('lot_status').map((s) => ({ label: meta.name(s.id), value: lots.lotsByStatus.find((x) => x.statusId === s.id)?.n ?? 0, color: s.color })).filter((x) => x.value > 0)} />
          </Card>
        </div>
      </>)}

      {sales && (<>
        <div className="dash-section">{t('dashboard.sec_sales')}</div>
        <div className="dash-grid">
          <Card title={t('dashboard.open_orders_list')} padded={false} actions={<Link to="/orders">{t('dashboard.see_all')}</Link>}>
            {sales.openOrders.length === 0 ? <Empty title={t('dashboard.no_open_orders')} /> : (
              <div className="table-wrap"><table className="table"><tbody>
                {sales.openOrders.map((o) => (
                  <tr key={o.id}>
                    <td><Link to={`/orders/${o.id}`} className="mono"><strong>{o.code}</strong></Link><div className="sub">{o.customerName}</div></td>
                    <td style={{ width: '42%' }}>
                      {o.requested > 0 ? <><Progress value={Math.min(o.itemCount, o.requested)} max={o.requested} tone={o.itemCount >= o.requested ? 'good' : 'warn'} /><div className="sub">{o.itemCount} / {o.requested}</div></> : <div className="sub">{t('dashboard.n_units', { count: o.itemCount })}</div>}
                    </td>
                  </tr>
                ))}
              </tbody></table></div>
            )}
          </Card>
          <Card title={t('dashboard.orders_status')}>
            <Donut data={meta.catalogOptions('order_status').map((s) => ({ label: meta.name(s.id), value: sales.ordersByStatus.find((x) => x.statusId === s.id)?.n ?? 0, color: s.color })).filter((x) => x.value > 0)} />
          </Card>
          <Card title={t('dashboard.sold_30d')}><Bars data={sales.soldByDay.map((x) => ({ label: shortDay(x.day), value: x.n }))} color="var(--good)" /></Card>
          {rev && (
            <Card title={t('dashboard.revenue_month', { currency: revCurrency })}>
              <Bars data={months.map((m) => ({ label: monthName(m), value: rev.filter((r) => r.month === m && r.currency === revCurrency).reduce((a, r) => a + r.total, 0) }))} color="var(--primary)" fmt={(n) => f.int(Math.round(n))} />
            </Card>
          )}
          {sales.topCustomers.length > 0 && <Card title={t('dashboard.top_customers')}><HBars data={sales.topCustomers.map((x) => ({ label: x.name, value: x.n }))} /></Card>}
        </div>
      </>)}

      {d.recent && (
        <Card title={t('dashboard.recent')} padded={false} actions={<Link to="/settings/audit">{t('dashboard.see_all')}</Link>}>
          {d.recent.length === 0 ? <Empty title={t('common.empty')} /> : (
            <div className="table-wrap"><table className="table"><tbody>
              {d.recent.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap muted">{f.dateTime(r.at)}</td>
                  <td>{auditText(r.action, r.data)}</td>
                  <td><EntityLink entity={r.entity} id={r.entityId} /></td>
                  <td>{r.userName ? <Badge>{r.userName}</Badge> : null}</td>
                </tr>
              ))}
            </tbody></table></div>
          )}
        </Card>
      )}
    </div>
  );
}
