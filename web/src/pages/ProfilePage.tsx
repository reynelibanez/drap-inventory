import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Card, Field, Input, PageHeader, Select, useErr, useToast } from '../components/ui';

export default function ProfilePage() {
  const { t } = useTranslation();
  const { user, companies, company, reload, setLanguage } = useAuth();
  const err = useErr();
  const toast = useToast();
  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [lang, setLang] = useState<string>(user?.language ?? '');
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyPw, setBusyPw] = useState(false);

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.patch('/auth/profile', { fullName: fullName.trim(), email: email.trim() || null, language: lang || null });
      if (lang === 'es' || lang === 'en') await setLanguage(lang);
      await reload(); toast.success(t('common.saved'));
    } catch (x) { toast.error(err(x)); } finally { setBusy(false); }
  }
  async function changePw(e: FormEvent) {
    e.preventDefault();
    if (next !== again) { toast.error(t('auth.passwords_differ')); return; }
    setBusyPw(true);
    try { await api.post('/auth/change-password', { current: cur, next }); toast.success(t('auth.password_changed')); setCur(''); setNext(''); setAgain(''); }
    catch (x) { toast.error(err(x)); } finally { setBusyPw(false); }
  }
  return (
    <>
      <PageHeader title={t('profile.title')} subtitle={user?.username} />
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <Card title={t('profile.data')}>
          <form className="stack" onSubmit={saveProfile}>
            <Field label={t('users.full_name')} required><Input value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
            <Field label={t('common.email')}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field label={t('common.language')} hint={t('profile.language_hint')}>
              <Select value={lang} onChange={(e) => setLang(e.target.value)}>
                <option value="">{t('common.browser_locale')}</option><option value="es">{t('common.es')}</option><option value="en">{t('common.en')}</option>
              </Select>
            </Field>
            <div><Button variant="primary" type="submit" loading={busy}>{t('common.save')}</Button></div>
          </form>
        </Card>
        <div className="stack">
          <Card title={t('profile.password')}>
            <form className="stack" onSubmit={changePw}>
              <Field label={t('auth.current_password')}><Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required /></Field>
              <Field label={t('auth.new_password')} hint={t('auth.password_rule')}><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required /></Field>
              <Field label={t('auth.repeat_password')}><Input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required /></Field>
              <div><Button variant="primary" type="submit" loading={busyPw}>{t('auth.change_action')}</Button></div>
            </form>
          </Card>
          <Card title={t('profile.companies')}>
            <ul className="stack sm" style={{ margin: 0, paddingLeft: 18 }}>
              {companies.map((c) => <li key={c.id}><strong>{c.name}</strong>{c.id === company?.id && ` (${t('platform.current')})`} — {t('shell.tech_number', { n: c.techNumber })}{c.isCompanyAdmin && ` · ${t('users.admin')}`}</li>)}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
