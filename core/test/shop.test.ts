import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthError, Embassy, FakePaymentGateway, HumanDevice, Shop, ShopError, Switchboard, defaultMandate, signAs } from '../src/index.ts';

const bag = { title: 'Шкіряний рюкзак', description: 'Ручна робота, коньячний колір', priceUAH: 3200, minPriceUAH: 2900, stock: 2 };

function setup() {
  const net = new Switchboard();
  const pay = new FakePaymentGateway();
  const phone = new HumanDevice('Оля');
  const olia = new Embassy({ id: 'olia', name: 'Оля', humanPublicKey: phone.publicKey, net, payments: pay });
  const cmd = (c: object) => olia.manageShop(phone.sign({ embassy: 'olia', ...c } as never));
  return { net, pay, phone, olia, cmd };
}

function readyShop() {
  const s = setup();
  s.cmd({ op: 'activate' });
  s.cmd({ op: 'profile', profile: { name: 'Олина майстерня', description: 'Сумки і рюкзаки зі шкіри', city: 'Львів' } });
  s.cmd({ op: 'add', product: bag });
  return s;
}

test('магазин є з коробки, але вимкнений до активації', async () => {
  const { olia, cmd } = setup();
  assert.equal(olia.shop.status, 'inactive');
  assert.throws(() => cmd({ op: 'add', product: bag }), ShopError);
  cmd({ op: 'activate' });
  assert.equal(olia.shop.status, 'draft');
  assert.throws(() => cmd({ op: 'activate' }), ShopError);
});

test('публікація показує, чого бракує, і списує $5 один раз', async () => {
  const { olia, pay, cmd } = setup();
  cmd({ op: 'activate' });
  assert.throws(() => cmd({ op: 'publish' }), /назва й опис магазину, хоча б один товар/);
  assert.equal(pay.charges.length, 0);

  cmd({ op: 'profile', profile: { name: 'Олина майстерня', description: 'Сумки і рюкзаки зі шкіри' } });
  cmd({ op: 'add', product: bag });
  cmd({ op: 'publish' });
  assert.equal(olia.shop.status, 'published');
  assert.deepEqual(pay.charges.map((c) => [c.amountCents, c.currency]), [[500, 'USD']]);

  // Зняти і знову опублікувати після змін — без повторної оплати.
  cmd({ op: 'unpublish' });
  cmd({ op: 'update', productId: [...olia.shop.products.keys()][0], patch: { priceUAH: 3400 } });
  cmd({ op: 'publish' });
  assert.equal(pay.charges.length, 1);
});

test('без платіжного шлюзу опублікувати не можна', async () => {
  const net = new Switchboard();
  const phone = new HumanDevice('Оля');
  const olia = new Embassy({ id: 'olia', name: 'Оля', humanPublicKey: phone.publicKey, net });
  const cmd = (c: object) => olia.manageShop(phone.sign({ embassy: 'olia', ...c } as never));
  cmd({ op: 'activate' });
  cmd({ op: 'profile', profile: { name: 'Олина майстерня', description: 'Сумки і рюкзаки зі шкіри' } });
  cmd({ op: 'add', product: bag });
  assert.throws(() => cmd({ op: 'publish' }), /платіжний шлюз/);
});

test('керувати магазином і платити може лише людина', async () => {
  const { olia, pay } = setup();
  const byAgent = signAs('agent', { embassy: 'olia', op: 'activate' as const }, olia.agentKeys.privateKey);
  assert.throws(() => olia.manageShop(byAgent), AuthError);
  const forged = signAs('human', { embassy: 'olia', op: 'publish' as const }, olia.agentKeys.privateKey);
  assert.throws(() => olia.manageShop(forged), AuthError);
  assert.equal(pay.charges.length, 0);
});

test('товари перевіряються', async () => {
  const s = new Shop('x');
  s.activate();
  assert.throws(() => s.addProduct({ ...bag, priceUAH: -1 }), ShopError);
  assert.throws(() => s.addProduct({ ...bag, minPriceUAH: 5000 }), ShopError);
  assert.throws(() => s.addProduct({ ...bag, stock: 1.5 }), ShopError);
  s.addProduct(bag);
  assert.throws(() => s.addProduct(bag), /вже є/);
});

test('посол готує товар, але додає його лише після згоди людини', async () => {
  const { olia, phone, cmd } = setup();
  cmd({ op: 'activate' });
  const d = olia.draftProduct({ title: 'Гаманець', description: 'Шкіра, на 6 карток', priceUAH: 900, stock: 5 });
  assert.equal(d.verdict, 'propose');
  assert.equal(olia.shop.products.size, 0);
  const [p] = olia.proposals.values();
  olia.decide(phone.sign({ embassy: 'olia', proposal: p.id, approve: true }));
  assert.equal(olia.shop.products.size, 1);
});

test('каталог і торг: посол покупця знаходить товар і купує в межах ціни', async () => {
  const { net, olia, cmd } = readyShop();
  // Оля дозволила послу закривати угоди до 5 000 грн без неї.
  olia.mandate = { ...olia.mandate, deals: { level: 2, maxAmountUAH: 5000 } };
  cmd({ op: 'publish' });

  const found = net.searchProducts('рюкзак');
  assert.equal(found.length, 1);
  assert.equal(found[0].shop, 'Олина майстерня');

  const buyerPhone = new HumanDevice('Андрій');
  const andrii = new Embassy({
    id: 'andrii', name: 'Андрій', humanPublicKey: buyerPhone.publicKey, net,
    mandate: { ...defaultMandate(), deals: { level: 2, maxAmountUAH: 5000 } },
  });
  net.ledger.credit('andrii', 10);
  const thread = andrii.startPurchase(
    buyerPhone.sign({ embassy: 'andrii', goal: { role: 'buyer', item: found[0].product.title, targetUAH: 2700, limitUAH: 3100 } }),
    found[0].embassy,
  );
  await net.flush();

  assert.equal(olia.commitments.get(thread), 'committed');
  assert.equal(andrii.commitments.get(thread), 'committed');
  const agreed = net.trace.find((s) => s.payload.type === 'ACCEPT')!.payload.terms.priceUAH!;
  assert.ok(agreed >= 2900 && agreed <= 3100, `ціна ${agreed}`);
  assert.equal([...olia.shop.products.values()][0].stock, 1);
});

test('неопублікований магазин нічого не продає', async () => {
  const { net, olia } = readyShop();
  assert.equal(net.searchProducts('рюкзак').length, 0);
  const phone = new HumanDevice('Андрій');
  const andrii = new Embassy({ id: 'andrii', name: 'Андрій', humanPublicKey: phone.publicKey, net });
  net.ledger.credit('andrii', 10);
  const thread = andrii.startPurchase(
    phone.sign({ embassy: 'andrii', goal: { role: 'buyer', item: bag.title, targetUAH: 2700, limitUAH: 3100 } }),
    'olia',
  );
  await net.flush();
  assert.equal(andrii.threads.get(thread)!.state, 'declined');
  assert.equal(olia.commitments.size, 0);
});
