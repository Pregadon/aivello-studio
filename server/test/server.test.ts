import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signAs } from '../../core/src/index.ts';
import { MemoryStore } from '../src/store.ts';
import { Person, paidEvent, startServer } from './helpers.ts';

const shopSteps = (olia: Person) => [
  olia.sign({ op: 'activate' }),
  olia.sign({ op: 'profile', profile: { name: 'Олина майстерня', description: 'Сумки і рюкзаки зі шкіри' } }),
  olia.sign({ op: 'add', product: { title: 'Рюкзак', description: 'Шкіра, ручна робота', priceUAH: 3200, minPriceUAH: 2900, stock: 2 } }),
];

test('реєстрація: ключ людини доводить себе підписом, читання лише з її підписом', async () => {
  const s = await startServer();
  const olia = new Person('olia', 'Оля');
  const r = await s.call('POST', '/v1/embassies', olia.register());
  assert.equal(r.status, 201);
  assert.equal(r.body.embassy.shop.status, 'inactive');

  // Чужий ключ у реєстрації, підписаній іншим пристроєм.
  const mallory = new Person('olia-2');
  const forged = { ...mallory.register(), payload: { ...mallory.register().payload, humanPublicKey: olia.register().payload.humanPublicKey } };
  assert.equal((await s.call('POST', '/v1/embassies', forged)).status, 403);

  assert.equal((await s.call('GET', '/v1/embassies/olia')).status, 403);
  assert.equal((await s.call('GET', '/v1/embassies/olia', undefined, mallory.readHeader())).status, 403);
  const me = await s.call('GET', '/v1/embassies/olia', undefined, olia.readHeader());
  assert.equal(me.status, 200);
  assert.equal(me.body.embassy.name, 'Оля');
  await s.close();
});

test('команди: повтор того самого підпису і застарілий підпис відкидаються', async () => {
  const s = await startServer();
  const olia = new Person('olia');
  await s.call('POST', '/v1/embassies', olia.register());
  const activate = olia.sign({ op: 'activate' });
  assert.equal((await s.call('POST', '/v1/embassies/olia/shop', activate)).status, 200);
  assert.equal((await s.call('POST', '/v1/embassies/olia/shop', activate)).status, 409);

  const old = signAs('human', { embassy: 'olia', op: 'unpublish' }, olia.device.keys.privateKey, new Date(Date.now() - 60 * 60 * 1000));
  const r = await s.call('POST', '/v1/embassies/olia/shop', old);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /застарів/);
  await s.close();
});

test('магазин: оплата через Stripe, вебхук публікує, повтор вебхука не шкодить, стан переживає перезапуск', async () => {
  const store = new MemoryStore();
  const s = await startServer(store);
  const olia = new Person('olia');
  await s.call('POST', '/v1/embassies', olia.register());
  for (const c of shopSteps(olia)) assert.equal((await s.call('POST', '/v1/embassies/olia/shop', c)).status, 200);

  const co = await s.call('POST', '/v1/embassies/olia/shop/checkout', olia.sign({ op: 'checkout', successUrl: 'https://posol.app/ok', cancelUrl: 'https://posol.app/no' }));
  assert.equal(co.status, 200);
  assert.equal(co.body.checkoutUrl, 'https://checkout.stripe.com/c/pay/cs_test_1');
  assert.equal(s.stripe.calls[0].get('line_items[0][price_data][unit_amount]'), '500');

  // Мінімальна ціна не видно ні в каталозі, ні в публічному вигляді магазину.
  assert.equal((await s.call('GET', '/v1/catalog?q=рюкзак')).body.results.length, 0);
  const paid = await s.webhook(paidEvent('evt_1', 'cs_test_1', 'olia'));
  assert.deepEqual(paid.body, { received: true, outcome: 'published' });
  assert.deepEqual(await s.webhook(paidEvent('evt_1', 'cs_test_1', 'olia')).then((r) => r.body), { received: true, duplicate: true });

  const found = (await s.call('GET', '/v1/catalog?q=рюкзак')).body.results;
  assert.equal(found.length, 1);
  assert.equal(found[0].product.minPriceUAH, undefined);
  await s.close();

  // Новий процес з тією ж базою.
  const s2 = await startServer(store);
  assert.equal((await s2.call('GET', '/v1/catalog?q=рюкзак')).body.results.length, 1);
  const me = await s2.call('GET', '/v1/embassies/olia', undefined, olia.readHeader());
  assert.equal(me.body.embassy.shop.status, 'published');
  assert.equal(me.body.embassy.shop.feePaid, true);
  await s2.close();
});

test('вебхук: підробку відкидаємо, чужу сесію записуємо і не публікуємо', async () => {
  const s = await startServer();
  const olia = new Person('olia');
  await s.call('POST', '/v1/embassies', olia.register());
  for (const c of shopSteps(olia)) await s.call('POST', '/v1/embassies/olia/shop', c);
  await s.call('POST', '/v1/embassies/olia/shop/checkout', olia.sign({ op: 'checkout', successUrl: 'https://x/ok', cancelUrl: 'https://x/no' }));

  assert.equal((await s.webhook(paidEvent('evt_f', 'cs_test_1', 'olia'), 'whsec_wrong')).status, 400);
  const other = await s.webhook(paidEvent('evt_2', 'cs_somebody_else', 'olia'));
  assert.equal(other.status, 200);
  assert.match(other.body.outcome, /^rejected/);
  const nobody = await s.webhook(paidEvent('evt_3', 'cs_test_1', 'ghost'));
  assert.match(nobody.body.outcome, /^rejected/);
  assert.equal(s.store instanceof MemoryStore && s.store.stripeEvents.size, 2);

  const me = await s.call('GET', '/v1/embassies/olia', undefined, olia.readHeader());
  assert.equal(me.body.embassy.shop.status, 'draft');
  await s.close();
});

test('торг між послами через API: рішення продавця чекає на нього навіть після перезапуску', async () => {
  const store = new MemoryStore();
  const s = await startServer(store);
  const serhii = new Person('serhii', 'Сергій');
  const marko = new Person('marko', 'Марко');
  await s.call('POST', '/v1/embassies', serhii.register());
  await s.call('POST', '/v1/embassies', marko.register());
  await s.call('POST', '/v1/embassies/marko/mandate', marko.sign({ domain: 'deals', rule: { level: 2, maxAmountUAH: 20000 } }));
  assert.equal((await s.call('POST', '/v1/embassies/serhii/sell', serhii.sign({ goal: { role: 'seller', item: 'bike', targetUAH: 15500, limitUAH: 14500 } }))).status, 200);
  const buy = await s.call('POST', '/v1/embassies/marko/buy', marko.sign({ seller: 'serhii', goal: { role: 'buyer', item: 'bike', targetUAH: 14000, limitUAH: 15000 } }));
  assert.equal(buy.status, 200, JSON.stringify(buy.body));
  const thread = buy.body.thread;
  await s.close();

  const s2 = await startServer(store);
  const seller = await s2.call('GET', '/v1/embassies/serhii', undefined, serhii.readHeader());
  const [p] = seller.body.embassy.proposals;
  assert.match(p.summary, /Угода з marko/);
  const ok = await s2.call('POST', '/v1/embassies/serhii/decisions', serhii.sign({ proposal: p.id, approve: true }));
  assert.equal(ok.status, 200);
  assert.equal(s2.world.get('serhii').commitments.get(thread), 'committed');
  assert.equal(s2.world.get('marko').commitments.get(thread), 'committed');
  await s2.close();
});

test('збій бази: зміна не лишається в пам’яті, а той самий підпис можна надіслати ще раз', async () => {
  const store = new MemoryStore();
  const s = await startServer(store);
  const olia = new Person('olia');
  await s.call('POST', '/v1/embassies', olia.register());
  const [activate] = shopSteps(olia);
  store.failNext = true;
  const r = await s.call('POST', '/v1/embassies/olia/shop', activate);
  assert.equal(r.status, 500);
  assert.equal(s.world.get('olia').shop.status, 'inactive');
  assert.equal((await s.call('POST', '/v1/embassies/olia/shop', activate)).status, 200);
  assert.equal(s.world.get('olia').shop.status, 'draft');
  await s.close();
});

test('помилки: непідписане тіло, невідоме посольство, завелике тіло', async () => {
  const s = await startServer();
  const olia = new Person('olia');
  await s.call('POST', '/v1/embassies', olia.register());
  assert.equal((await s.call('POST', '/v1/embassies/olia/shop', { embassy: 'olia', op: 'activate' })).status, 403);
  assert.equal((await s.call('POST', '/v1/embassies/nobody/shop', olia.sign({ op: 'activate' }))).status, 404);
  assert.equal((await s.call('POST', '/v1/embassies/olia/shop', 'не json')).status, 400);
  assert.equal((await s.call('POST', '/v1/embassies/olia/shop', 'x'.repeat(70_000))).status, 413);
  assert.equal((await s.call('DELETE', '/v1/catalog')).status, 405);
  await s.close();
});
