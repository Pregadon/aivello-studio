import { createHash } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { BoundsError, SimpleNegotiator, enforceBounds } from './brain.ts';
import type { Brain, DealGoal, Move } from './brain.ts';
import { Journal } from './journal.ts';
import type { NewEntry } from './journal.ts';
import { applyMandateChange, defaultMandate, evaluate } from './mandate.ts';
import type { MandateChange } from './mandate.ts';
import type { Endpoint, Switchboard } from './network.ts';
import { ProtocolError, Thread } from './protocol.ts';
import type { Message, MsgType, Terms, Topic } from './protocol.ts';
import { newKeyPair, signAs, verifySigned } from './seal.ts';
import type { KeyPair, Signed } from './seal.ts';
import { PUBLISH_FEE, Shop, ShopError } from './shop.ts';
import type { PaymentGateway, Product, Receipt, ShopProfile } from './shop.ts';
import { StripeError, receiptFromCheckoutEvent, verifyStripeWebhook } from './stripe.ts';
import type { CheckoutProvider } from './stripe.ts';
import type { Decision, Intent, Mandate, PolicyContext } from './types.ts';

// Дія посла як дані, а не замикання: її можна зберегти в базі й виконати після перезапуску.
export type Action =
  | { kind: 'none' }
  | { kind: 'deliver'; thread: string }
  | { kind: 'send'; thread: string; type: MsgType; terms: Terms }
  | { kind: 'accept'; thread: string; priceUAH: number }
  | { kind: 'commit'; thread: string }
  | { kind: 'withdraw'; thread: string }
  | { kind: 'addProduct'; product: Omit<Product, 'id'> };

export interface Proposal {
  id: number;
  intent: Intent;
  createdAt: Date;
  action: Action;
  onReject: Action;
}

// Документи, які людина підписує ключем на своєму пристрої.
export interface HumanDecision {
  embassy: string;
  proposal: number;
  approve: boolean;
}
export interface QuietToggle {
  embassy: string;
  quiet: boolean;
}
export interface GoalGrant {
  embassy: string;
  goal: DealGoal;
}

// Команди магазину, які людина підписує сама.
export type ShopCommand =
  | { embassy: string; op: 'activate' }
  | { embassy: string; op: 'profile'; profile: ShopProfile }
  | { embassy: string; op: 'add'; product: Omit<Product, 'id'> }
  | { embassy: string; op: 'update'; productId: string; patch: Partial<Omit<Product, 'id'>> }
  | { embassy: string; op: 'remove'; productId: string }
  | { embassy: string; op: 'publish' }
  | { embassy: string; op: 'unpublish' };

// Людина погоджується заплатити $5 і опублікувати магазин.
export interface ShopCheckoutRequest {
  embassy: string;
  op: 'checkout';
  successUrl: string;
  cancelUrl: string;
}

export type Commitment = 'pending_human' | 'committed' | 'rejected' | 'cancelled';

export class AuthError extends Error {}

export interface EmbassyOptions {
  id: string;
  name: string;
  humanPublicKey: KeyObject;
  net: Switchboard;
  brain?: Brain;
  payments?: PaymentGateway;
  checkout?: CheckoutProvider;
  mandate?: Mandate;
  clock?: () => Date;
  // Ключ посла, збережений раніше. Без нього посольство отримує новий.
  agentKeys?: KeyPair;
}

export class Embassy implements Endpoint {
  id: string;
  name: string;
  humanPublicKey: KeyObject;
  // Ключ посла живе тільки тут. Ключа людини посольство не має.
  agentKeys: KeyPair;
  mandate: Mandate;
  quiet = false;
  trusted = new Set<string>();
  journal: Journal;
  brain: Brain;
  net: Switchboard;
  clock: () => Date;

  proposals = new Map<number, Proposal>();
  sellerGoals = new Map<string, DealGoal>();
  // Магазин є з коробки, але вимкнений, доки людина його не активує.
  shop: Shop;
  payments?: PaymentGateway;
  checkout?: CheckoutProvider;
  // Сесія Stripe Checkout, яку чекаємо після підпису людини.
  pendingCheckout?: string;
  threadProducts = new Map<string, string>();
  threadGoals = new Map<string, DealGoal>();
  threads = new Map<string, Thread>();
  myLastPrice = new Map<string, number>();
  commitments = new Map<string, Commitment>();
  // Як скасувати виконані дії (номер запису журналу → дія). Зберігається разом зі станом.
  undoActions = new Map<number, Action>();
  seq = 0;
  nextProposal = 1;

  constructor(o: EmbassyOptions) {
    this.id = o.id;
    this.name = o.name;
    this.humanPublicKey = o.humanPublicKey;
    this.agentKeys = o.agentKeys ?? newKeyPair();
    this.net = o.net;
    this.brain = o.brain ?? new SimpleNegotiator();
    this.mandate = o.mandate ?? defaultMandate();
    this.clock = o.clock ?? (() => new Date());
    this.shop = new Shop(o.id);
    this.payments = o.payments;
    this.checkout = o.checkout;
    this.journal = new Journal(this.clock);
    o.net.register(this);
  }

  get agentPublicKey(): KeyObject {
    return this.agentKeys.publicKey;
  }

  isTrusted(embassyId: string): boolean {
    return this.trusted.has(embassyId);
  }

  ctx(): PolicyContext {
    return { quiet: this.quiet, isTrusted: (id) => this.isTrusted(id) };
  }

  // Єдиний шлях, яким посол щось робить: намір → рушій політик → дія, депеша або відмова.
  act(intent: Intent, action: Action, undo?: Action, onReject: Action = { kind: 'none' }): Decision {
    const d = evaluate(intent, this.mandate, this.ctx());
    const base = { summary: intent.summary, reason: d.reason, rule: d.rule };
    if (d.verdict === 'execute') {
      this.run(action);
      const entry = this.journal.record({ ...base, actor: 'agent', kind: 'executed', compensate: undo && (() => this.run(undo)) });
      if (undo) this.undoActions.set(entry.id, undo);
    } else if (d.verdict === 'propose') {
      const id = this.nextProposal++;
      this.proposals.set(id, { id, intent, createdAt: this.clock(), action, onReject });
      this.journal.record({ ...base, actor: 'agent', kind: 'proposed' });
    } else {
      this.journal.record({ ...base, actor: 'agent', kind: 'denied' });
    }
    return d;
  }

  // Виконує дію. Сюди веде і рішення рушія, і згода людини з депеші.
  run(a: Action): void {
    switch (a.kind) {
      case 'none':
        return;
      case 'deliver':
        return this.net.send(this.thread(a.thread).messages[0]);
      case 'send':
        return this.sendRaw(this.thread(a.thread), a.type, a.terms);
      case 'accept': {
        const t = this.thread(a.thread);
        this.sendRaw(t, 'ACCEPT', { ...t.lastTerms, priceUAH: a.priceUAH });
        return this.commit(t, a.priceUAH);
      }
      case 'commit':
        this.commitments.set(a.thread, 'committed');
        return this.adjustStock(this.thread(a.thread), -1);
      case 'withdraw': {
        const t = this.thread(a.thread);
        if (this.commitments.get(t.id) === 'committed') this.adjustStock(t, +1);
        this.commitments.set(t.id, 'rejected');
        if (t.state === 'agreed') this.sendRaw(t, 'WITHDRAW', {});
        return;
      }
      case 'addProduct':
        this.shop.addProduct(a.product);
        return;
    }
  }

  thread(id: string): Thread {
    const t = this.threads.get(id);
    if (!t) throw new ProtocolError(`Невідомий потік ${id}`);
    return t;
  }

  // ---------- Дії людини (лише з її підписом) ----------

  requireHuman<T extends { embassy: string }>(signed: Signed<T>): T {
    if (!verifySigned(signed, this.humanPublicKey, 'human')) throw new AuthError('Потрібен підпис людини');
    if (signed.payload.embassy !== this.id) throw new AuthError('Підпис належить іншому посольству');
    return signed.payload;
  }

  decide(signed: Signed<HumanDecision>): void {
    const d = this.requireHuman(signed);
    const p = this.proposals.get(d.proposal);
    if (!p) throw new AuthError('Такого рішення немає в депеші');
    this.proposals.delete(p.id);
    this.run(d.approve ? p.action : p.onReject);
    this.journal.record({
      actor: 'human',
      kind: 'decided',
      summary: `${d.approve ? 'Погоджено' : 'Відхилено'}: ${p.intent.summary}`,
      reason: 'Рішення людини з депеші',
    });
  }

  changeMandate(signed: Signed<MandateChange>): void {
    this.mandate = applyMandateChange(this.mandate, signed, this.humanPublicKey, this.id);
    this.journal.record({
      actor: 'human',
      kind: 'decided',
      summary: `Мандат змінено: ${signed.payload.domain}`,
      reason: 'Рішення людини',
    });
  }

  setQuiet(signed: Signed<QuietToggle>): void {
    const q = this.requireHuman(signed);
    this.quiet = q.quiet;
    this.journal.record({
      actor: 'human',
      kind: 'decided',
      summary: q.quiet ? 'Увімкнено режим тиші' : 'Посла знову ввімкнено',
      reason: 'Рішення людини',
    });
    if (!q.quiet) return;
    // Під час тиші посол відкликає всі свої незавершені переговори.
    for (const t of this.threads.values()) {
      if (t.state === 'open' || t.state === 'negotiating') {
        this.sendRaw(t, 'WITHDRAW', {});
        this.journal.record({ actor: 'system', kind: 'executed', summary: `Відкликано переговори ${t.id}`, reason: 'Режим тиші' });
      }
    }
  }

  // Людина дозволяє продавати річ у межах ціни.
  listForSale(signed: Signed<GoalGrant>): void {
    const { goal } = this.requireHuman(signed);
    if (goal.role !== 'seller') throw new AuthError('Це ціль покупця');
    this.sellerGoals.set(goal.item, goal);
    this.journal.record({
      actor: 'human',
      kind: 'decided',
      summary: `Виставлено на продаж: ${goal.item}, від ${goal.limitUAH} грн`,
      reason: 'Рішення людини',
    });
  }

  // Людина дозволяє купити річ у межах бюджету. Посол відкриває переговори.
  startPurchase(signed: Signed<GoalGrant>, sellerId: string, note?: string): string {
    const { goal } = this.requireHuman(signed);
    if (goal.role !== 'buyer') throw new AuthError('Це ціль продавця');
    const threadId = `${this.id}-t${++this.seq}`;
    const req = this.sign({
      id: `${this.id}-m${++this.seq}`,
      thread: threadId,
      from: this.id,
      to: sellerId,
      type: 'REQUEST',
      topic: 'deal',
      terms: { item: goal.item },
      note,
      sentAt: this.clock().toISOString(),
    });
    const t = new Thread(req);
    this.threads.set(threadId, t);
    this.threadGoals.set(threadId, goal);
    this.act(
      { domain: 'deals', action: 'request', summary: `Запит продавцю ${sellerId}: ${goal.item}`, counterparty: sellerId, withinHumanGoal: true },
      { kind: 'deliver', thread: threadId },
    );
    return threadId;
  }

  // ---------- Магазин ----------

  manageShop(signed: Signed<ShopCommand>): void {
    const c = this.requireHuman(signed);
    const note = (summary: string): void => {
      this.journal.record({ actor: 'human', kind: 'decided', summary, reason: 'Рішення людини' });
    };
    switch (c.op) {
      case 'activate':
        this.shop.activate();
        return note('Магазин активовано');
      case 'profile':
        this.shop.setProfile(c.profile);
        return note(`Профіль магазину: ${c.profile.name}`);
      case 'add':
        return note(`Додано товар: ${this.shop.addProduct(c.product).title}`);
      case 'update':
        return note(`Змінено товар: ${this.shop.updateProduct(c.productId, c.patch).title}`);
      case 'remove':
        this.shop.removeProduct(c.productId);
        return note('Товар прибрано');
      case 'publish':
        return this.publishShop(note);
      case 'unpublish':
        this.shop.unpublish();
        this.net.unlistShop(this.id);
        return note('Магазин знято з публікації');
    }
  }

  publishShop(note: (s: string) => void): void {
    const gaps = this.shop.missing();
    if (gaps.length) throw new ShopError(`Бракує: ${gaps.join(', ')}`);
    let receipt = this.shop.receipt;
    if (!receipt) {
      if (!this.payments) throw new ShopError('Оплата недоступна: не підключено платіжний шлюз');
      receipt = this.payments.charge(this.id, PUBLISH_FEE.amountCents, PUBLISH_FEE.currency, 'Публікація магазину');
      note(`Оплачено публікацію магазину: $${PUBLISH_FEE.amountCents / 100}`);
    }
    this.shop.publish(receipt);
    this.net.listShop(this.id, this.shop);
    note(`Магазин «${this.shop.profile!.name}» опубліковано`);
  }

  // Крок 1 справжньої оплати: людина підписує згоду, ми створюємо сторінку оплати Stripe.
  // Повертає посилання на оплату або undefined, якщо $5 уже сплачено і магазин опубліковано одразу.
  async startShopCheckout(signed: Signed<ShopCheckoutRequest>): Promise<string | undefined> {
    const req = this.requireHuman(signed);
    const gaps = this.shop.missing();
    if (gaps.length) throw new ShopError(`Бракує: ${gaps.join(', ')}`);
    const note = (summary: string): void => {
      this.journal.record({ actor: 'human', kind: 'decided', summary, reason: 'Рішення людини' });
    };
    if (this.shop.feePaid) {
      this.publishShop(note);
      return undefined;
    }
    if (!this.checkout) throw new ShopError('Оплата недоступна: не підключено Stripe');
    const session = await this.checkout.createCheckout({
      embassy: this.id,
      amountCents: PUBLISH_FEE.amountCents,
      currency: PUBLISH_FEE.currency,
      productName: `Публікація магазину «${this.shop.profile!.name}»`,
      successUrl: req.successUrl,
      cancelUrl: req.cancelUrl,
      // Ключ з підпису людини: повтор того самого рішення не відкриє другу оплату.
      idempotencyKey: `shop-publish-${createHash('sha256').update(signed.sig).digest('hex')}`,
    });
    this.pendingCheckout = session.id;
    note(`Відкрито оплату публікації: $${PUBLISH_FEE.amountCents / 100}`);
    return session.url;
  }

  // Крок 2: перевірений вебхук Stripe підтвердив оплату. Публікуємо магазин.
  completeShopCheckout(receipt: Receipt & { sessionId: string }): void {
    if (receipt.embassy !== this.id) throw new ShopError('Оплата належить іншому посольству');
    if (this.shop.receipt?.id === receipt.id) return; // Stripe може надіслати подію повторно.
    if (!this.pendingCheckout || receipt.sessionId !== this.pendingCheckout) throw new ShopError('Невідома сесія оплати');
    this.shop.publish(receipt);
    this.pendingCheckout = undefined;
    this.net.listShop(this.id, this.shop);
    this.journal.record({
      actor: 'system',
      kind: 'executed',
      summary: `Stripe підтвердив оплату $${receipt.amountCents / 100}, магазин «${this.shop.profile!.name}» опубліковано`,
      reason: 'Вебхук Stripe',
    });
  }

  // Посол може підготувати товар (наприклад, з фото і голосового). Товар — публічний контент,
  // тож його додавання підпорядковується сфері «Публікації» мандату.
  draftProduct(product: Omit<Product, 'id'>): Decision {
    if (this.shop.status === 'inactive') throw new ShopError('Спершу активуй магазин');
    return this.act(
      { domain: 'posts', action: 'shop-draft', summary: `Додати в магазин: ${product.title} за ${product.priceUAH} грн` },
      { kind: 'addProduct', product },
    );
  }

  shopGoal(item: string): { goal: DealGoal; productId: string } | undefined {
    if (this.shop.status !== 'published') return undefined;
    const p = this.shop.inStock().find((x) => x.title === item);
    if (!p) return undefined;
    return {
      productId: p.id,
      goal: { role: 'seller', item: p.title, targetUAH: p.priceUAH, limitUAH: p.minPriceUAH ?? p.priceUAH },
    };
  }

  // ---------- Протокол посол-посол ----------

  sign(m: Message): Signed<Message> {
    return signAs('agent', m, this.agentKeys.privateKey, this.clock());
  }

  other(t: Thread): string {
    return t.parties[0] === this.id ? t.parties[1] : t.parties[0];
  }

  sendRaw(t: Thread, type: MsgType, terms: Terms, topic: Topic = t.topic): void {
    const signed = this.sign({
      id: `${this.id}-m${++this.seq}`,
      thread: t.id,
      from: this.id,
      to: this.other(t),
      type,
      topic,
      terms,
      sentAt: this.clock().toISOString(),
    });
    t.apply(signed);
    if (terms.priceUAH !== undefined) this.myLastPrice.set(t.id, terms.priceUAH);
    this.net.send(signed);
  }

  receive(signed: Signed<Message>): void {
    const m = signed.payload;
    if (m.to !== this.id) return;
    if (!verifySigned(signed, this.net.publicKeyOf(m.from), 'agent')) {
      this.journal.record({ actor: 'system', kind: 'denied', summary: `Відкинуто повідомлення від ${m.from}`, reason: 'Невірний підпис' });
      return;
    }
    let t = this.threads.get(m.thread);
    try {
      if (!t) {
        t = new Thread(signed);
        this.threads.set(m.thread, t);
      } else {
        t.apply(signed);
      }
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      this.journal.record({ actor: 'system', kind: 'denied', summary: `Відкинуто ${m.type} від ${m.from}`, reason: e.message });
      return;
    }
    this.journal.record({
      actor: 'system',
      kind: 'received',
      summary: `${m.type} від ${m.from}${m.terms.priceUAH !== undefined ? `: ${m.terms.priceUAH} грн` : ''}`,
      reason: 'Вхідне повідомлення',
    });
    this.respond(t, m);
  }

  respond(t: Thread, m: Message): void {
    switch (m.type) {
      case 'REQUEST':
        return this.onRequest(t, m);
      case 'OFFER':
      case 'COUNTER':
        return this.onPrice(t, m);
      case 'ACCEPT':
        return this.commit(t, this.myLastPrice.get(t.id)!);
      case 'DECLINE':
      case 'WITHDRAW':
        if (this.commitments.get(t.id) === 'committed') {
          this.commitments.set(t.id, 'cancelled');
          this.adjustStock(t, +1);
          this.journal.record({ actor: 'system', kind: 'received', summary: `Угоду ${t.id} скасувала інша сторона`, reason: m.type });
        }
        return;
    }
  }

  onRequest(t: Thread, m: Message): void {
    const item = m.topic === 'deal' ? m.terms.item : undefined;
    const fromShop = item ? this.shopGoal(item) : undefined;
    if (fromShop) this.threadProducts.set(t.id, fromShop.productId);
    const goal = item ? (this.sellerGoals.get(item) ?? fromShop?.goal) : undefined;
    if (!goal) {
      this.act(
        { domain: 'inbox', action: 'decline', summary: `Ввічливо відмовити ${m.from}: немає такої пропозиції`, counterparty: m.from },
        { kind: 'send', thread: t.id, type: 'DECLINE', terms: {} },
      );
      return;
    }
    this.threadGoals.set(t.id, goal);
    this.act(
      { domain: 'deals', action: 'offer', summary: `Пропозиція ${m.from}: ${goal.item} за ${goal.targetUAH} грн`, counterparty: m.from, withinHumanGoal: true },
      { kind: 'send', thread: t.id, type: 'OFFER', terms: { item: goal.item, priceUAH: goal.targetUAH } },
    );
  }

  onPrice(t: Thread, m: Message): void {
    const goal = this.threadGoals.get(t.id);
    const their = m.terms.priceUAH;
    if (!goal || their === undefined) return;

    let move: Move;
    try {
      move = enforceBounds(
        goal,
        their,
        this.brain.nextMove({
          goal,
          theirPriceUAH: their,
          myLastPriceUAH: this.myLastPrice.get(t.id),
          round: t.rounds,
          untrustedNote: m.note,
        }),
      );
    } catch (e) {
      if (!(e instanceof BoundsError)) throw e;
      this.journal.record({ actor: 'system', kind: 'denied', summary: 'Хід мозку заблоковано', reason: e.message, rule: 'bounds' });
      move = { type: 'COUNTER', priceUAH: goal.limitUAH };
      if (this.myLastPrice.get(t.id) === goal.limitUAH) move = { type: 'DECLINE' };
    }

    const who = m.from;
    if (move.type === 'ACCEPT') {
      this.act(
        { domain: 'deals', action: 'accept', summary: `Згода з ${who} на ${their} грн`, counterparty: who, withinHumanGoal: true },
        { kind: 'accept', thread: t.id, priceUAH: their },
      );
    } else if (move.type === 'COUNTER') {
      const price = move.priceUAH!;
      this.act(
        { domain: 'deals', action: 'counter', summary: `Зустрічна ${who}: ${price} грн`, counterparty: who, withinHumanGoal: true },
        { kind: 'send', thread: t.id, type: 'COUNTER', terms: { item: goal.item, priceUAH: price } },
      );
    } else {
      this.act(
        { domain: 'deals', action: 'decline', summary: `Відмова ${who}: ціна поза межами`, counterparty: who, withinHumanGoal: true },
        { kind: 'send', thread: t.id, type: 'DECLINE', terms: {} },
      );
    }
  }

  // Умови погоджено. Чи зобов'язуватись без людини, вирішує мандат.
  commit(t: Thread, priceUAH: number): void {
    const goal = this.threadGoals.get(t.id);
    const who = this.other(t);
    const withdraw: Action = { kind: 'withdraw', thread: t.id };
    this.commitments.set(t.id, 'pending_human');
    const d = this.act(
      {
        domain: 'deals',
        action: 'commit',
        summary: `Угода з ${who}: ${goal?.item ?? 'річ'} за ${priceUAH} грн`,
        counterparty: who,
        amountUAH: priceUAH,
      },
      { kind: 'commit', thread: t.id },
      withdraw,
      withdraw,
    );
    if (d.verdict === 'deny') this.run(withdraw);
  }

  // Продаж товару з магазину змінює залишок; скасування повертає його.
  adjustStock(t: Thread, delta: number): void {
    const id = this.threadProducts.get(t.id);
    const p = id ? this.shop.products.get(id) : undefined;
    if (p) p.stock = Math.max(0, p.stock + delta);
  }

  // ---------- Депеша ----------

  dispatch(since: Date): string[] {
    const recent = this.journal.since(since);
    const count = (k: NewEntry['kind'], actor = 'agent') => recent.filter((e) => e.kind === k && e.actor === actor).length;
    const lines = [
      `Депеша для: ${this.name}`,
      `Посол зробив сам: ${count('executed')}. Відмовився робити: ${count('denied') + count('denied', 'system')}.`,
    ];
    if (this.proposals.size === 0) lines.push('Рішень, що чекають на тебе, немає.');
    for (const p of this.proposals.values()) lines.push(`Потрібне рішення #${p.id}: ${p.intent.summary}`);
    return lines;
  }
}

// Пристрій людини. Тільки тут живе ключ, яким ставиться печатка людини.
export class HumanDevice {
  name: string;
  keys: KeyPair = newKeyPair();

  constructor(name: string) {
    this.name = name;
  }

  get publicKey(): KeyObject {
    return this.keys.publicKey;
  }

  sign<T>(payload: T): Signed<T> {
    return signAs('human', payload, this.keys.privateKey);
  }
}

// Обробник вебхука Stripe для сервера: перевіряє підпис і передає оплату потрібному посольству.
export function handleStripeWebhook(
  rawBody: string,
  signatureHeader: string,
  endpointSecret: string,
  findEmbassy: (id: string) => Embassy | undefined,
  nowSec?: number,
): 'published' | 'ignored' {
  const event = verifyStripeWebhook(rawBody, signatureHeader, endpointSecret, nowSec);
  const receipt = receiptFromCheckoutEvent(event);
  if (!receipt) return 'ignored';
  const embassy = findEmbassy(receipt.embassy);
  if (!embassy) throw new StripeError(`Невідоме посольство в оплаті: ${receipt.embassy}`);
  embassy.completeShopCheckout(receipt);
  return 'published';
}
