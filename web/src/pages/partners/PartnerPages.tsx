import { useTranslation } from 'react-i18next';
import { useCatalogOpts } from '../../components/grid/helpers';
import { CrudPage, type CrudConfig } from './CrudPage';
import type { GridColumn } from '../../components/grid/DataGrid';

const contactRender = (r: any) => (
  <div>{r.contactName ?? <span className="muted">—</span>}<div className="sub">{[r.email, r.phone].filter(Boolean).join(' · ')}</div></div>
);
const contactCols = (t: (k: string) => string): GridColumn<any>[] => [
  { key: 'contactName', title: t('partners.contact'), render: contactRender },
  { key: 'email', title: t('common.email'), hidden: true }, { key: 'phone', title: t('common.phone'), hidden: true },
];

export function SuppliersPage() {
  const { t } = useTranslation();
  const cfg: CrudConfig = {
    path: '/suppliers', queryKey: 'suppliers', title: t('partners.suppliers'), subtitle: t('partners.suppliers_hint'), newLabel: t('partners.new_supplier'),
    editLabel: t('partners.edit_supplier'), emptyLabel: t('partners.no_suppliers'), viewPerm: 'suppliers.view', managePerm: 'suppliers.manage',
    fields: [
      { key: 'name', label: t('common.name'), required: true }, { key: 'contactName', label: t('partners.contact') },
      { key: 'email', label: t('common.email'), type: 'email' }, { key: 'phone', label: t('common.phone'), type: 'tel' },
      { key: 'country', label: t('common.country') }, { key: 'address', label: t('common.address') },
      { key: 'notes', label: t('common.notes'), kind: 'textarea' },
    ],
    columns: [
      { key: 'name', title: t('common.name'), render: (r) => <strong>{r.name}</strong> }, ...contactCols(t),
      { key: 'country', title: t('common.country'), type: 'select' }, { key: 'address', title: t('common.address'), hidden: true }, { key: 'notes', title: t('common.notes'), hidden: true },
    ],
  };
  return <CrudPage cfg={cfg} />;
}

export function CustomersPage() {
  const { t } = useTranslation();
  const typeOpts = useCatalogOpts('customer_type');
  const cfg: CrudConfig = {
    path: '/customers', queryKey: 'customers', title: t('partners.customers'), subtitle: t('partners.customers_hint'), newLabel: t('partners.new_customer'),
    editLabel: t('partners.edit_customer'), emptyLabel: t('partners.no_customers'), viewPerm: 'customers.view', managePerm: 'customers.manage',
    fields: [
      { key: 'name', label: t('common.name'), required: true }, { key: 'customerTypeId', label: t('partners.customer_type'), kind: 'catalog', catalog: 'customer_type' },
      { key: 'contactName', label: t('partners.contact') }, { key: 'email', label: t('common.email'), type: 'email' }, { key: 'phone', label: t('common.phone'), type: 'tel' },
      { key: 'country', label: t('common.country') }, { key: 'taxId', label: t('partners.tax_id') }, { key: 'address', label: t('common.address') },
      { key: 'notes', label: t('common.notes'), kind: 'textarea' },
    ],
    columns: [
      { key: 'name', title: t('common.name'), render: (r) => <strong>{r.name}</strong> },
      { key: 'customerType', title: t('partners.customer_type'), type: 'select', options: typeOpts, value: (r) => (r.customerTypeId ? String(r.customerTypeId) : null) },
      ...contactCols(t),
      { key: 'country', title: t('common.country'), type: 'select' }, { key: 'taxId', title: t('partners.tax_id'), hidden: true },
      { key: 'address', title: t('common.address'), hidden: true }, { key: 'notes', title: t('common.notes'), hidden: true },
    ],
  };
  return <CrudPage cfg={cfg} />;
}

export function SellersPage() {
  const { t } = useTranslation();
  const cfg: CrudConfig = {
    path: '/sellers', queryKey: 'sellers', title: t('partners.sellers'), subtitle: t('partners.sellers_hint'), newLabel: t('partners.new_seller'),
    editLabel: t('partners.edit_seller'), emptyLabel: t('partners.no_sellers'), viewPerm: 'sellers.view', managePerm: 'sellers.manage',
    fields: [
      { key: 'name', label: t('common.name'), required: true }, { key: 'email', label: t('common.email'), type: 'email' }, { key: 'phone', label: t('common.phone'), type: 'tel' },
      { key: 'membershipId', label: t('partners.linked_user'), kind: 'member' },
    ],
    columns: [
      { key: 'name', title: t('common.name'), render: (r) => <strong>{r.name}</strong> },
      { key: 'email', title: t('common.email') }, { key: 'phone', title: t('common.phone') },
    ],
  };
  return <CrudPage cfg={cfg} />;
}
