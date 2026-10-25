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
import type { Decision, Intent, Mandate, PolicyContext } from './types.ts';

export interface Proposal {
  id: number;
  intent: Intent;
  createdAt: Date;
  approve: () => void;
  reject: () => void;
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

export type Commitment = 'pending_human' | 'committed' | 'rejected' | 'cancelled';

export class AuthError extends Error {}

export interface EmbassyOptions {
  id: string;
  name: string;
  humanPublicKey: KeyObject;
  net: Switchboard;
  brain?: Brain;
  mandate?: Mandate;
  clock?: () => Date;
}

export class Embassy implements Endpoint {
  id: string;
  name: string;
  humanPublicKey: KeyObject;
  // Ключ посла живе тільки тут. Ключа людини посольство не має.
  agentKeys: KeyPair = newKeyPair();
  mandate: Mandate;
  quiet = false;
  trusted = new Set<string>();
  journal: Journal;
  brain: Brain;
  net: Switchboard;
  clock: () => Date;

  proposals = new Map<number, Proposal>();
  sellerGoals = new Map<string, DealGoal>();
  threadGoals = new Map<string, DealGoal>();
  threads = new Map<string, Thread>();
  myLastPrice = new Map<string, number>();
  commitments = new Map<string, Commitment>();
  seq = 0;
  nextProposal = 1;

  constructor(o: EmbassyOptions) {
    this.id = o.id;
    this.name = o.name;
    this.humanPublicKey = o.humanPublicKey;
    this.net = o.net;
    this.brain = o.brain ?? new SimpleNegotiator();
    this.mandate = o.mandate ?? defaultMandate();
    this.clock = o.clock ?? (() => new Date());
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
  act(intent: Intent, perform: () => void, compensate?: () => void, onReject: () => void = () => {}): Decision {
    const d = evaluate(intent, this.mandate, this.ctx());
    const base = { summary: intent.summary, reason: d.reason, rule: d.rule };
    if (d.verdict === 'execute') {
      perform();
      this.journal.record({ ...base, actor: 'agent', kind: 'executed', compensate });
    } else if (d.verdict === 'propose') {
      const id = this.nextProposal++;
      this.proposals.set(id, { id, intent, createdAt: this.clock(), approve: perform, reject: onReject });
      this.journal.record({ ...base, actor: 'agent', kind: 'proposed' });
    } else {
      this.journal.record({ ...base, actor: 'agent', kind: 'denied' });
    }
    return d;
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
    if (d.approve) p.approve();
    else p.reject();
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
      () => this.net.send(req),
    );
    return threadId;
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
          this.journal.record({ actor: 'system', kind: 'received', summary: `Угоду ${t.id} скасувала інша сторона`, reason: m.type });
        }
        return;
    }
  }

  onRequest(t: Thread, m: Message): void {
    const goal = m.topic === 'deal' && m.terms.item ? this.sellerGoals.get(m.terms.item) : undefined;
    if (!goal) {
      this.act(
        { domain: 'inbox', action: 'decline', summary: `Ввічливо відмовити ${m.from}: немає такої пропозиції`, counterparty: m.from },
        () => this.sendRaw(t, 'DECLINE', {}),
      );
      return;
    }
    this.threadGoals.set(t.id, goal);
    this.act(
      { domain: 'deals', action: 'offer', summary: `Пропозиція ${m.from}: ${goal.item} за ${goal.targetUAH} грн`, counterparty: m.from, withinHumanGoal: true },
      () => this.sendRaw(t, 'OFFER', { item: goal.item, priceUAH: goal.targetUAH }),
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
      const d = this.act(
        { domain: 'deals', action: 'accept', summary: `Згода з ${who} на ${their} грн`, counterparty: who, withinHumanGoal: true },
        () => this.sendRaw(t, 'ACCEPT', { item: goal.item, priceUAH: their }),
      );
      if (d.verdict === 'execute') this.commit(t, their);
    } else if (move.type === 'COUNTER') {
      const price = move.priceUAH!;
      this.act(
        { domain: 'deals', action: 'counter', summary: `Зустрічна ${who}: ${price} грн`, counterparty: who, withinHumanGoal: true },
        () => this.sendRaw(t, 'COUNTER', { item: goal.item, priceUAH: price }),
      );
    } else {
      this.act(
        { domain: 'deals', action: 'decline', summary: `Відмова ${who}: ціна поза межами`, counterparty: who, withinHumanGoal: true },
        () => this.sendRaw(t, 'DECLINE', {}),
      );
    }
  }

  // Умови погоджено. Чи зобов'язуватись без людини, вирішує мандат.
  commit(t: Thread, priceUAH: number): void {
    const goal = this.threadGoals.get(t.id);
    const who = this.other(t);
    const withdraw = () => {
      this.commitments.set(t.id, 'rejected');
      if (t.state === 'agreed') this.sendRaw(t, 'WITHDRAW', {});
    };
    this.commitments.set(t.id, 'pending_human');
    const d = this.act(
      {
        domain: 'deals',
        action: 'commit',
        summary: `Угода з ${who}: ${goal?.item ?? 'річ'} за ${priceUAH} грн`,
        counterparty: who,
        amountUAH: priceUAH,
      },
      () => this.commitments.set(t.id, 'committed'),
      withdraw,
      withdraw,
    );
    if (d.verdict === 'deny') withdraw();
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
