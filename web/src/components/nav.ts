import {
  BadgeDollarSign, BookMarked, Boxes, ChartColumn, CreditCard, FlaskConical, History, LayoutDashboard, Package, Settings2,
  ShieldCheck, ShoppingCart, SlidersHorizontal, Tag, Truck, UserCog, UserRound, Users, Warehouse, KeyRound, Wrench, Upload, type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../lib/auth';

export interface NavItem { to: string; label: string; icon: LucideIcon; perm?: string | string[]; platform?: boolean }
export interface NavGroup { title?: string; items: NavItem[] }

export const NAV: NavGroup[] = [
  { items: [{ to: '/', label: 'nav.dashboard', icon: LayoutDashboard, perm: 'dashboard.view' }] },
  {
    title: 'nav.group_operation',
    items: [
      { to: '/lots', label: 'nav.lots', icon: Package, perm: 'lots.view' },
      { to: '/lots/import', label: 'nav.import_equipment', icon: Upload, perm: 'lots.import' },
      { to: '/testing', label: 'nav.testing', icon: FlaskConical, perm: 'units.test' },
      { to: '/units', label: 'nav.units', icon: Boxes, perm: 'units.view' },
      { to: '/locations', label: 'nav.locations', icon: Warehouse, perm: 'locations.view' },
      { to: '/assets', label: 'nav.assets', icon: Wrench, perm: 'assets.view' },
    ],
  },
  {
    title: 'nav.group_sales',
    items: [
      { to: '/orders', label: 'nav.orders', icon: ShoppingCart, perm: 'sales.view' },
      { to: '/pricing', label: 'nav.pricing', icon: BadgeDollarSign, perm: 'prices.manage' },
      { to: '/customers', label: 'nav.customers', icon: Users, perm: 'customers.view' },
      { to: '/sellers', label: 'nav.sellers', icon: UserRound, perm: 'sellers.view' },
    ],
  },
  { title: 'nav.group_purchasing', items: [{ to: '/suppliers', label: 'nav.suppliers', icon: Truck, perm: 'suppliers.view' }] },
  { title: 'nav.group_reports', items: [{ to: '/reports', label: 'nav.reports', icon: ChartColumn, perm: 'reports.view' }] },
  {
    title: 'nav.group_settings',
    items: [
      { to: '/settings/catalogs', label: 'nav.catalogs', icon: BookMarked, perm: 'catalogs.view' },
      { to: '/settings/equipment', label: 'nav.equipment', icon: SlidersHorizontal, perm: 'equipment.view' },
      { to: '/settings/labels', label: 'nav.labels', icon: Tag, perm: 'labels.manage' },
      { to: '/settings/users', label: 'nav.users', icon: UserCog, perm: 'users.view' },
      { to: '/settings/roles', label: 'nav.roles', icon: KeyRound, perm: 'roles.view' },
      { to: '/settings/company', label: 'nav.company', icon: Settings2, perm: 'settings.manage' },
      { to: '/settings/billing', label: 'nav.billing', icon: CreditCard, perm: 'billing.manage' },
      { to: '/settings/audit', label: 'nav.audit', icon: History, perm: 'audit.view' },
      { to: '/platform', label: 'nav.platform', icon: ShieldCheck, platform: true },
    ],
  },
];


/** Opciones del menú que el usuario puede ver (según permisos), agrupadas. */
export function useVisibleNav(): NavGroup[] {
  const { user, can, canAny } = useAuth();
  return NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => (i.platform ? !!user?.isPlatformAdmin : !i.perm || (Array.isArray(i.perm) ? canAny(...i.perm) : can(i.perm)))),
  })).filter((g) => g.items.length);
}
