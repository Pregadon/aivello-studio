// Перевірка на справжньому PostgreSQL. Запуск: TEST_DATABASE_URL=postgres://… npm test
// База очищується перед тестами, тож не вказуй робочу.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgStore } from '../src/pg-store.ts';
import { Person, paidEvent, startServer } from './helpers.ts';

const url = process.env.TEST_DATABASE_URL;

test('PostgreSQL: магазин, оплата і перезапуск', { skip: !url && 'TEST_DATABASE_URL не задано' }, async () => {
  const reset = new PgStore(url!);
  await reset.pool.query('DROP TABLE IF EXISTS embassies, attention_ledger, human_nonces, stripe_events');
  await reset.close();

  const s = await startServer(new PgStore(url!));
  const olia = new Person('olia');
  assert.equal((await s.call('POST', '/v1/embassies', olia.register())).status, 201);
  await s.call('POST', '/v1/embassies/olia/shop', olia.sign({ op: 'activate' }));
  await s.call('POST', '/v1/embassies/olia/shop', olia.sign({ op: 'profile', profile: { name: 'Олина майстерня', description: 'Сумки і рюкзаки зі шкіри' } }));
  const add = olia.sign({ op: 'add', product: { title: 'Рюкзак', description: 'Шкіра', priceUAH: 3200, stock: 1 } });
  await s.call('POST', '/v1/embassies/olia/shop', add);
  const co = await s.call('POST', '/v1/embassies/olia/shop/checkout', olia.sign({ op: 'checkout', successUrl: 'https://x/ok', cancelUrl: 'https://x/no' }));
  assert.ok(co.body.checkoutUrl);
  assert.equal((await s.webhook(paidEvent('evt_pg', 'cs_test_1', 'olia'))).body.outcome, 'published');
  await s.close();
  await s.store.close();

  // Другий процес: стан з бази, повторні підпис і подія не проходять.
  const s2 = await startServer(new PgStore(url!));
  assert.equal((await s2.call('GET', '/v1/catalog?q=рюкзак')).body.results.length, 1);
  assert.equal((await s2.call('POST', '/v1/embassies/olia/shop', add)).status, 409);
  assert.equal((await s2.webhook(paidEvent('evt_pg', 'cs_test_1', 'olia'))).body.duplicate, true);

  const pg = (s2.store as PgStore).pool;
  const row = (await pg.query('SELECT agent_key_enc, state FROM embassies WHERE id = $1', ['olia'])).rows[0];
  assert.ok(row.agent_key_enc.startsWith('v1.'));
  assert.ok(!JSON.stringify(row).includes('PRIVATE KEY'), 'ключ посла не має лежати в базі відкрито');
  assert.equal(row.state.shop.status, 'published');
  await s2.close();
  await s2.store.close();
});
