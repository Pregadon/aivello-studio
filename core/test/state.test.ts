import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Embassy,
  FakePaymentGateway,
  HumanDevice,
  Switchboard,
  defaultMandate,
  exportPrivateKey,
  importKeyPair,
  restoreEmbassy,
  restoreLedger,
  snapshotEmbassy,
  snapshotLedger,
} from '../src/index.ts';

// Імітує перезапуск сервера: стан проходить через JSON (як через jsonb у PostgreSQL), ключі окремо.
function reboot(embassies: Embassy[], net: Switchboard) {
  const saved = embassies.map((e) => ({ state: JSON.stringify(snapshotEmbassy(e)), key: exportPrivateKey(e.agentKeys.privateKey) }));
  const ledger = JSON.stringify(snapshotLedger(net.ledger));
  const net2 = new Switchboard();
  restoreLedger(net2.ledger, JSON.parse(ledger));
  const out = saved.map((s) => restoreEmbassy(JSON.parse(s.state), { net: net2, agentKeys: importKeyPair(s.key) }));
  return { net: net2, embassies: out };
}

async function bikeDeal() {
  const net = new Switchboard();
  const sPhone = new HumanDevice('Сергій');
  const bPhone = new HumanDevice('Марко');
  const seller = new Embassy({ id: 'serhii', name: 'Сергій', humanPublicKey: sPhone.publicKey, net });
  const buyer = new Embassy({
    id: 'marko', name: 'Марко', humanPublicKey: bPhone.publicKey, net,
    mandate: { ...defaultMandate(), deals: { level: 2, maxAmountUAH: 20000 } },
  });
  net.ledger.credit('marko', 20);
  seller.listForSale(sPhone.sign({ embassy: 'serhii', goal: { role: 'seller', item: 'bike', targetUAH: 15500, limitUAH: 14500 } }));
  const thread = buyer.startPurchase(
    bPhone.sign({ embassy: 'marko', goal: { role: 'buyer', item: 'bike', targetUAH: 14000, limitUAH: 15000 } }),
    'serhii',
  );
  await net.flush();
  return { net, sPhone, bPhone, seller, buyer, thread };
}

test('стан: рішення, що чекає на людину, переживає перезапуск', async () => {
  const { net, sPhone, seller, buyer, thread } = await bikeDeal();
  assert.equal(seller.commitments.get(thread), 'pending_human');

  const { net: net2, embassies: [s2, b2] } = reboot([seller, buyer], net);
  assert.equal(s2.proposals.size, 1);
  assert.equal(s2.threads.get(thread)!.state, 'agreed');
  assert.equal(net2.ledger.balance('marko'), net.ledger.balance('marko'));

  const [p] = s2.proposals.values();
  s2.decide(sPhone.sign({ embassy: 'serhii', proposal: p.id, approve: false }));
  await net2.flush();
  assert.equal(s2.commitments.get(thread), 'rejected');
  assert.equal(b2.commitments.get(thread), 'cancelled');
  // Ключ посла той самий: інший посол прийняв його WITHDRAW після перезапуску.
  assert.equal(b2.threads.get(thread)!.state, 'withdrawn');
});

test('стан: скасування виконаної угоди працює і після перезапуску', async () => {
  const { net, buyer, seller, thread } = await bikeDeal();
  const done = buyer.journal.entries.find((e) => e.kind === 'executed' && e.undoUntil)!;
  const { embassies: [, b2] } = reboot([seller, buyer], net);
  b2.journal.undo(done.id);
  assert.equal(b2.commitments.get(thread), 'rejected');
  assert.ok(b2.journal.entries.at(-1)!.summary.startsWith('Скасовано'));
});

test('стан: опублікований магазин знову в каталозі після перезапуску', async () => {
  const net = new Switchboard();
  const phone = new HumanDevice('Оля');
  const olia = new Embassy({ id: 'olia', name: 'Оля', humanPublicKey: phone.publicKey, net, payments: new FakePaymentGateway() });
  const cmd = (c: object) => olia.manageShop(phone.sign({ embassy: 'olia', ...c } as never));
  cmd({ op: 'activate' });
  cmd({ op: 'profile', profile: { name: 'Олина майстерня', description: 'Сумки і рюкзаки зі шкіри' } });
  cmd({ op: 'add', product: { title: 'Рюкзак', description: 'Шкіра', priceUAH: 3200, stock: 1 } });
  cmd({ op: 'publish' });

  const { net: net2, embassies: [o2] } = reboot([olia], net);
  assert.equal(o2.shop.status, 'published');
  assert.equal(net2.searchProducts('рюкзак').length, 1);
  // Нумерація товарів продовжується, а не починається знову.
  o2.manageShop(phone.sign({ embassy: 'olia', op: 'add', product: { title: 'Гаманець', description: 'Шкіра', priceUAH: 900, stock: 2 } }));
  assert.deepEqual([...o2.shop.products.keys()], ['olia-p1', 'olia-p2']);
});
