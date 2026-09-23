import { useTranslation } from 'react-i18next';
import { BillingPanel } from '../../components/BillingPanel';
import { PageHeader } from '../../components/ui';

export default function BillingPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('billing.title')} subtitle={t('billing.subtitle')} />
      <BillingPanel />
    </>
  );
}
