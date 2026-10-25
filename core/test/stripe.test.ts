import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  Embassy,
  HumanDevice,
  ShopError,
  StripeCheckout,
  StripeError,
  Switchboard,
  handleStripeWebhook,
  receiptFromCheckoutEvent,
  verifyStripeWebhook,
} from '../src/index.ts';

const SECRET = 'whsec_test_secret';

function sign(body: string, t: number, secret = SECRET): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

function paidEvent(sessionId: string, embassy: string, amount = 500, currency = 'usd') {
  return JSON.stringify({
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId, payment_status: 'paid', amount_total: amount, currency, created: 1_790_000_000,
        metadata: { embassy, purpose: 'shop_publish' },
      },
    },
  });
}

// Підмінений Stripe API: запам'ятовує запит і повертає сесію.
function fakeStripe() {
  const calls: { url: string; headers: Record<string, string>; body: URLSearchParams }[] = [];
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: new URLSearchParams(init.body) });
    return { ok: true, status: 200, json: async () => ({ id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' }) };
  };
  return { calls, provider: new StripeCheckout('sk_test_abc', fetchImpl) };
}

async function readyShop() {
  const net = new Switchboard();
  const stripe = fakeStripe();
  const phone = new HumanDevice('Оля');
  const olia = new Embassy({ id: 'olia', name: 'Оля', humanPublicKey: phone.publicKey, net, checkout: stripe.provider });
  const cmd = (c: object) => olia.manageShop(phone.sign({ embassy: 'olia', ...c } as never));
  cmd({ op: 'activate' });
  cmd({ op: 'profile', profile: { name: 'Олина майстерня', description: 'Сумки і рюкзаки зі шкіри' } });
  cmd({ op: 'add', product: { title: 'Рюкзак', description: 'Шкіра', priceUAH: 3200, stock: 1 } });
  const checkout = () =>
    olia.startShopCheckout(phone.sign({ embassy: 'olia', op: 'checkout', successUrl: 'https://posol.app/ok', cancelUrl: 'https://posol.app/cancel' }));
  return { net, stripe, phone, olia, checkout };
}

test('Stripe: сесія оплати створюється на $5 з даними посольства', async () => {
  const { stripe, olia, checkout } = await readyShop();
  const url = await checkout();
  assert.equal(url, 'https://checkout.stripe.com/c/pay/cs_test_123');
  assert.equal(olia.pendingCheckout, 'cs_test_123');
  assert.equal(olia.shop.status, 'draft');

  const [call] = stripe.calls;
  assert.equal(call.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(call.headers.Authorization, 'Bearer sk_test_abc');
  assert.equal(call.body.get('mode'), 'payment');
  assert.equal(call.body.get('line_items[0][price_data][unit_amount]'), '500');
  assert.equal(call.body.get('line_items[0][price_data][currency]'), 'usd');
  assert.equal(call.body.get('metadata[embassy]'), 'olia');
  assert.match(call.headers['Idempotency-Key'], /^shop-publish-[0-9a-f]{64}$/);
});

test('Stripe: перевірений вебхук публікує магазин, повтор події нічого не ламає', async () => {
  const { olia, checkout } = await readyShop();
  await checkout();
  const body = paidEvent('cs_test_123', 'olia');
  const now = 1_790_000_100;
  const find = (id: string) => (id === 'olia' ? olia : undefined);
  assert.equal(handleStripeWebhook(body, sign(body, now), SECRET, find, now), 'published');
  assert.equal(olia.shop.status, 'published');
  assert.equal(olia.shop.receipt?.currency, 'USD');
  assert.equal(handleStripeWebhook(body, sign(body, now), SECRET, find, now), 'published');
});

test('Stripe: підроблений або застарілий вебхук відкидається', () => {
  const body = paidEvent('cs_test_123', 'olia');
  const now = 1_790_000_100;
  assert.throws(() => verifyStripeWebhook(body, sign(body, now, 'whsec_wrong'), SECRET, now), StripeError);
  assert.throws(() => verifyStripeWebhook(body.replace('500', '5'), sign(body, now), SECRET, now), StripeError);
  assert.throws(() => verifyStripeWebhook(body, sign(body, now - 1000), SECRET, now), /застарів/);
  assert.throws(() => verifyStripeWebhook(body, 'garbage', SECRET, now), StripeError);
});

test('Stripe: оплата за чужу сесію або меншу суму не публікує магазин', async () => {
  const { olia, checkout } = await readyShop();
  await checkout();
  const now = 1_790_000_100;
  const find = () => olia;

  const otherSession = paidEvent('cs_other', 'olia');
  assert.throws(() => handleStripeWebhook(otherSession, sign(otherSession, now), SECRET, find, now), ShopError);

  const cheap = paidEvent('cs_test_123', 'olia', 100);
  assert.throws(() => handleStripeWebhook(cheap, sign(cheap, now), SECRET, find, now), ShopError);
  assert.equal(olia.shop.status, 'draft');
});

test('Stripe: інші події та неоплачені сесії ігноруються', () => {
  assert.equal(receiptFromCheckoutEvent({ id: 'e', type: 'payment_intent.created', data: { object: {} } }), undefined);
  const unpaid = JSON.parse(paidEvent('cs', 'olia'));
  unpaid.data.object.payment_status = 'unpaid';
  assert.equal(receiptFromCheckoutEvent(unpaid), undefined);
});

test('Stripe: без підпису людини оплату не відкрити; ключ має бути секретним', async () => {
  const { olia } = await readyShop();
  const { signAs } = await import('../src/index.ts');
  const byAgent = signAs('agent', { embassy: 'olia', op: 'checkout' as const, successUrl: 'x', cancelUrl: 'y' }, olia.agentKeys.privateKey);
  await assert.rejects(() => olia.startShopCheckout(byAgent));
  assert.throws(() => new StripeCheckout('pk_test_public'), StripeError);
});

test('Stripe: помилка API показує причину', async () => {
  const failing = new StripeCheckout('sk_test_x', async () => ({
    ok: false, status: 400, json: async () => ({ error: { message: 'Invalid currency' } }),
  }));
  await assert.rejects(
    () => failing.createCheckout({ embassy: 'a', amountCents: 500, currency: 'USD', productName: 'x', successUrl: 'u', cancelUrl: 'c', idempotencyKey: 'k' }),
    /Invalid currency/,
  );
});
