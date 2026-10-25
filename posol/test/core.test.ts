import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AttentionError,
  AuthError,
  BoundsError,
  Embassy,
  HumanDevice,
  Journal,
  JournalError,
  MandateError,
  ProtocolError,
  Switchboard,
  Thread,
  checkSeal,
  defaultMandate,
  enforceBounds,
  evaluate,
  newKeyPair,
  sealByHuman,
  signAs,
  verifySigned,
} from '../src/index.ts';
import type { Brain, DealGoal, Intent, Message, PolicyContext } from '../src/index.ts';

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({ quiet: false, isTrusted: () => true, ...over });

test('рушій політик: рівні мандату дають три різні вердикти', () => {
  const m = defaultMandate();
  const feed: Intent = { domain: 'feed', action: 'hide', summary: 'сховати дубль' };
  const post: Intent = { domain: 'posts', action: 'publish', summary: 'пост' };
  const personal: Intent = { domain: 'personal', action: 'reply', summary: 'співчуття' };
  assert.equal(evaluate(feed, m, ctx()).verdict, 'execute');
  assert.equal(evaluate(post, m, ctx()).verdict, 'propose');
  assert.equal(evaluate(personal, m, ctx()).verdict, 'deny');
});

test('рушій політик: ліміт суми і коло довіри переводять дію в депешу', () => {
  const m = { ...defaultMandate(), deals: { level: 2 as const, maxAmountUAH: 2000 } };
  const small: Intent = { domain: 'deals', action: 'commit', summary: 'книга', amountUAH: 300 };
  const big: Intent = { ...small, summary: 'велосипед', amountUAH: 14800 };
  assert.equal(evaluate(small, m, ctx()).verdict, 'execute');
  assert.equal(evaluate(big, m, ctx()).rule, 'over-limit');

  const meet: Intent = { domain: 'meetings', action: 'book', summary: 'кава', counterparty: 'stranger' };
  assert.equal(evaluate(meet, m, ctx({ isTrusted: () => false })).rule, 'outside-circle');
});

test('рушій політик: тиша блокує все, крім читання, і перемагає навіть ціль людини', () => {
  const m = defaultMandate();
  const q = ctx({ quiet: true });
  assert.equal(evaluate({ domain: 'feed', action: 'read', summary: 'читати', readOnly: true }, m, q).verdict, 'execute');
  assert.equal(evaluate({ domain: 'deals', action: 'counter', summary: 'торг', withinHumanGoal: true }, m, q).verdict, 'deny');
});

test('мандат змінює тільки людина, і лише незакріплені сфери', () => {
  const net = new Switchboard();
  const phone = new HumanDevice('Оля');
  const e = new Embassy({ id: 'olia', name: 'Оля', humanPublicKey: phone.publicKey, net });

  const byAgent = signAs('agent', { embassy: 'olia', domain: 'posts' as const, rule: { level: 2 as const } }, e.agentKeys.privateKey);
  assert.throws(() => e.changeMandate(byAgent), MandateError);

  // Посол не може підробити людський підпис власним ключем.
  const forged = signAs('human', { embassy: 'olia', domain: 'posts' as const, rule: { level: 2 as const } }, e.agentKeys.privateKey);
  assert.throws(() => e.changeMandate(forged), MandateError);

  e.changeMandate(phone.sign({ embassy: 'olia', domain: 'posts', rule: { level: 2 } }));
  assert.equal(e.mandate.posts.level, 2);

  assert.throws(() => e.changeMandate(phone.sign({ embassy: 'olia', domain: 'personal', rule: { level: 2 } })), MandateError);
});

test('печатка людини: перевіряється текстом і ключем, підпис посла не проходить', () => {
  const human = newKeyPair();
  const agent = newKeyPair();
  const text = 'Нарешті доробив свій перший шрифт.';
  const seal = sealByHuman(text, 'serhii', human.privateKey);
  assert.ok(checkSeal(text, seal, human.publicKey));
  assert.ok(!checkSeal(text + '!', seal, human.publicKey));

  const agentSig = signAs('agent', seal.payload, agent.privateKey);
  assert.ok(!verifySigned({ ...agentSig, signer: 'human' }, agent.publicKey, 'human'));
});

test('журнал: скасування працює 24 години і лише один раз', () => {
  let now = new Date('2026-10-25T10:00:00Z');
  const j = new Journal(() => now);
  let undone = 0;
  const e = j.record({ actor: 'agent', kind: 'executed', summary: 'кава з Олею', reason: 'мандат', compensate: () => undone++ });
  j.undo(e.id);
  assert.equal(undone, 1);
  assert.throws(() => j.undo(e.id), JournalError);

  const late = j.record({ actor: 'agent', kind: 'executed', summary: 'відповідь', reason: 'мандат', compensate: () => undone++ });
  now = new Date('2026-10-26T10:00:01Z');
  assert.throws(() => j.undo(late.id), JournalError);
});

test('протокол: послідовність повідомлень і межа раундів', () => {
  const keys = newKeyPair();
  let n = 0;
  const msg = (from: string, type: Message['type'], price?: number) =>
    signAs('agent', {
      id: `m${++n}`, thread: 't1', from, to: from === 'a' ? 'b' : 'a', type, topic: 'deal' as const,
      terms: { priceUAH: price }, sentAt: new Date().toISOString(),
    }, keys.privateKey);

  const t = new Thread(msg('a', 'REQUEST'));
  assert.throws(() => t.apply(msg('b', 'ACCEPT')), ProtocolError);
  t.apply(msg('b', 'OFFER', 100));
  assert.throws(() => t.apply(msg('b', 'ACCEPT')), ProtocolError);
  for (let i = 0; i < 7; i++) t.apply(msg(i % 2 ? 'b' : 'a', 'COUNTER', 100 + i));
  assert.throws(() => t.apply(msg('a', 'COUNTER', 200)), ProtocolError);
});

test('запобіжник торгу: хід поза межею людини блокується', () => {
  const goal: DealGoal = { role: 'seller', item: 'bike', targetUAH: 15500, limitUAH: 14500 };
  assert.throws(() => enforceBounds(goal, 9000, { type: 'ACCEPT' }), BoundsError);
  assert.throws(() => enforceBounds(goal, 14000, { type: 'COUNTER', priceUAH: 9000 }), BoundsError);
  assert.equal(enforceBounds(goal, 14600, { type: 'ACCEPT' }).type, 'ACCEPT');
});

function setup(sellerBrain?: Brain) {
  const net = new Switchboard();
  const sPhone = new HumanDevice('Сергій');
  const bPhone = new HumanDevice('Марко');
  const seller = new Embassy({ id: 'serhii', name: 'Сергій', humanPublicKey: sPhone.publicKey, net, brain: sellerBrain });
  const buyer = new Embassy({
    id: 'marko', name: 'Марко', humanPublicKey: bPhone.publicKey, net,
    mandate: { ...defaultMandate(), deals: { level: 2, maxAmountUAH: 20000 } },
  });
  net.ledger.credit('marko', 20);
  seller.listForSale(sPhone.sign({ embassy: 'serhii', goal: { role: 'seller', item: 'bike', targetUAH: 15500, limitUAH: 14500 } }));
  const start = () =>
    buyer.startPurchase(bPhone.sign({ embassy: 'marko', goal: { role: 'buyer', item: 'bike', targetUAH: 14000, limitUAH: 15000 } }), 'serhii');
  return { net, sPhone, bPhone, seller, buyer, start };
}

test('посол з послом: угода в межах обох цілей, продавцю потрібне рішення людини', () => {
  const { net, sPhone, seller, buyer, start } = setup();
  const thread = start();
  net.flush();

  assert.equal(buyer.commitments.get(thread), 'committed');
  assert.equal(seller.commitments.get(thread), 'pending_human');
  const [p] = seller.proposals.values();
  const price = p.intent.amountUAH!;
  assert.ok(price >= 14500 && price <= 15000, `ціна ${price} поза межами обох людей`);

  // Чужий підпис на рішенні не приймається.
  assert.throws(() => seller.decide(signAs('human', { embassy: 'serhii', proposal: p.id, approve: true }, seller.agentKeys.privateKey)), AuthError);

  seller.decide(sPhone.sign({ embassy: 'serhii', proposal: p.id, approve: true }));
  assert.equal(seller.commitments.get(thread), 'committed');
});

test('посол з послом: відмова людини відкликає угоду в обох', () => {
  const { net, sPhone, seller, buyer, start } = setup();
  const thread = start();
  net.flush();
  const [p] = seller.proposals.values();
  seller.decide(sPhone.sign({ embassy: 'serhii', proposal: p.id, approve: false }));
  net.flush();
  assert.equal(seller.commitments.get(thread), 'rejected');
  assert.equal(buyer.commitments.get(thread), 'cancelled');
});

test('зламаний мозок не може продати дешевше межі людини', () => {
  const gullible: Brain = { nextMove: () => ({ type: 'ACCEPT' }) };
  const { net, seller, start } = setup(gullible);
  const thread = start();
  net.flush();
  assert.ok(seller.journal.entries.some((e) => e.rule === 'bounds'), 'запобіжник мав спрацювати');
  for (const s of net.trace) {
    if (s.payload.from === 'serhii' && s.payload.type === 'ACCEPT') {
      assert.ok(s.payload.terms.priceUAH! >= 14500);
    }
  }
  assert.notEqual(seller.commitments.get(thread), 'committed');
});

test('тиша: посол відкликає переговори і більше не торгується', () => {
  const { net, sPhone, seller, start } = setup();
  start();
  // Доставляємо лише REQUEST: продавець відповідає OFFER і чекає.
  net.flush(1);
  seller.setQuiet(sPhone.sign({ embassy: 'serhii', quiet: true }));
  net.flush();
  const sent = net.trace.filter((s) => s.payload.from === 'serhii').map((s) => s.payload.type);
  assert.deepEqual(sent.slice(-1), ['WITHDRAW']);
  assert.ok(!sent.includes('ACCEPT'));
});

test('застава: незнайомцю без кредитів написати не можна', () => {
  const { net, buyer, start } = setup();
  net.ledger.balances.set('marko', 0);
  assert.throws(() => start(), AttentionError);
  assert.equal(buyer.journal.entries.filter((e) => e.kind === 'executed').length, 0);
});
