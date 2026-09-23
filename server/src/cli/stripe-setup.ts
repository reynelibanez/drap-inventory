/**
 * Crea en Stripe los productos y precios de los planes pagos (Business, Enterprise; mensual y anual)
 * y guarda sus ids en la base de datos. Hay que correr esto UNA VEZ, desde una computadora con acceso
 * normal a internet (esta operación no se puede hacer desde el entorno de desarrollo en la nube).
 *
 * Uso:
 *   npm run stripe:setup                 (usa las claves de .env, modo prueba o real según cuál pongas)
 *   npm run stripe:setup -- --force      (vuelve a crear precios aunque el plan ya tenga uno)
 *   npm run stripe:setup -- --webhook-url https://tuservidor.com/api/webhooks/stripe
 *       (además crea el endpoint de webhooks en Stripe y muestra la clave STRIPE_WEBHOOK_SECRET a guardar en .env)
 */
import Stripe from 'stripe';
import { config } from '../config.js';
import { pool, withGlobal } from '../db.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? '' : process.argv[++i]);
}
const force = args.has('force');
const webhookUrl = args.get('webhook-url');

async function main() {
  if (!config.stripe.secretKey) {
    throw new Error('Falta STRIPE_SECRET_KEY en el archivo .env. Agrégala primero (la clave secreta de tu cuenta de Stripe) y vuelve a correr este comando.');
  }
  const stripe = new Stripe(config.stripe.secretKey);
  console.log(`\n=== Configurando Stripe (${config.stripe.secretKey.startsWith('sk_live_') ? 'MODO REAL' : 'modo de prueba'}) ===\n`);

  const plans = await withGlobal((db) => db.rows<{
    id: number; key: string; name: any; price_monthly_cents: number | null; price_annual_cents: number | null;
    stripe_price_id_monthly: string | null; stripe_price_id_annual: string | null;
  }>('SELECT id, key, name, price_monthly_cents, price_annual_cents, stripe_price_id_monthly, stripe_price_id_annual FROM subscription_plans ORDER BY sort_order'));

  for (const plan of plans) {
    if (plan.price_monthly_cents == null && plan.price_annual_cents == null) {
      console.log(`- ${plan.key}: plan gratis, no necesita producto en Stripe. Omitido.`);
      continue;
    }
    if (plan.stripe_price_id_monthly && plan.stripe_price_id_annual && !force) {
      console.log(`- ${plan.key}: ya tiene precios configurados (usa --force para recrearlos). Omitido.`);
      continue;
    }
    const productName = `${plan.name?.es ?? plan.key} (DRAP Inventory)`;
    const product = await stripe.products.create({ name: productName, metadata: { planKey: plan.key } });
    console.log(`- ${plan.key}: producto creado (${product.id})`);

    let monthlyId = plan.stripe_price_id_monthly;
    if (plan.price_monthly_cents != null) {
      const price = await stripe.prices.create({
        product: product.id, currency: 'usd', unit_amount: plan.price_monthly_cents,
        recurring: { interval: 'month' }, metadata: { planKey: plan.key, interval: 'monthly' },
      });
      monthlyId = price.id;
      console.log(`    precio mensual: ${price.id} ($${(plan.price_monthly_cents / 100).toFixed(2)}/mes)`);
    }
    let annualId = plan.stripe_price_id_annual;
    if (plan.price_annual_cents != null) {
      const price = await stripe.prices.create({
        product: product.id, currency: 'usd', unit_amount: plan.price_annual_cents,
        recurring: { interval: 'year' }, metadata: { planKey: plan.key, interval: 'annual' },
      });
      annualId = price.id;
      console.log(`    precio anual: ${price.id} ($${(plan.price_annual_cents / 100).toFixed(2)}/año)`);
    }
    await withGlobal((db) => db.query(
      'UPDATE subscription_plans SET stripe_price_id_monthly = $2, stripe_price_id_annual = $3 WHERE id = $1',
      [plan.id, monthlyId, annualId]));
  }

  if (webhookUrl) {
    console.log(`\nCreando endpoint de webhooks en Stripe apuntando a: ${webhookUrl}`);
    const endpoint = await stripe.webhookEndpoints.create({
      url: webhookUrl,
      enabled_events: [
        'checkout.session.completed',
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'invoice.payment_failed',
      ],
    });
    console.log(`Endpoint creado (${endpoint.id}).`);
    console.log(`\n*** IMPORTANTE: agrega esta línea a tu archivo .env: ***`);
    console.log(`STRIPE_WEBHOOK_SECRET=${endpoint.secret}\n`);
  } else {
    console.log(`\nNo se creó el endpoint de webhooks (no pasaste --webhook-url).`);
    console.log(`Para recibir avisos de pagos, entra a tu cuenta de Stripe -> Developers -> Webhooks -> Add endpoint,`);
    console.log(`con la URL https://TU-DOMINIO/api/webhooks/stripe y estos eventos:`);
    console.log(`  checkout.session.completed, customer.subscription.created, customer.subscription.updated,`);
    console.log(`  customer.subscription.deleted, invoice.payment_failed`);
    console.log(`Copia la "Signing secret" (empieza con whsec_...) y agrégala a .env como STRIPE_WEBHOOK_SECRET.`);
  }

  console.log('\nListo. Reinicia el servidor (start.bat) para que tome los precios nuevos.\n');
  await pool.end();
}

main().catch(async (e) => { console.error('\nERROR:', e.message ?? e); await pool.end(); process.exit(1); });
