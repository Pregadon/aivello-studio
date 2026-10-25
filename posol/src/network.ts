import type { KeyObject } from 'node:crypto';
import { AttentionLedger } from './attention.ts';
import type { Message } from './protocol.ts';
import { verifySigned } from './seal.ts';
import type { Signed } from './seal.ts';

export interface Endpoint {
  id: string;
  agentPublicKey: KeyObject;
  isTrusted(embassyId: string): boolean;
  receive(msg: Signed<Message>): void;
}

export class NetworkError extends Error {}

// Комутатор MVP: центральний сервер, через який посли обмінюються повідомленнями.
// Повідомлення стають у чергу, щоб відповіді не викликали одна одну рекурсивно.
export class Switchboard {
  endpoints = new Map<string, Endpoint>();
  queue: Signed<Message>[] = [];
  ledger = new AttentionLedger();
  clock: () => Date;
  // Усе, що пройшло через комутатор: для демо і налагодження.
  trace: Signed<Message>[] = [];

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  register(ep: Endpoint): void {
    if (this.endpoints.has(ep.id)) throw new NetworkError(`Посольство ${ep.id} уже зареєстроване`);
    this.endpoints.set(ep.id, ep);
  }

  publicKeyOf(id: string): KeyObject {
    const ep = this.endpoints.get(id);
    if (!ep) throw new NetworkError(`Невідоме посольство ${id}`);
    return ep.agentPublicKey;
  }

  send(signed: Signed<Message>): void {
    const m = signed.payload;
    if (!verifySigned(signed, this.publicKeyOf(m.from), 'agent')) {
      throw new NetworkError('Підпис посла не пройшов перевірку');
    }
    const to = this.endpoints.get(m.to);
    if (!to) throw new NetworkError(`Невідоме посольство ${m.to}`);
    if (m.type === 'REQUEST' && !to.isTrusted(m.from)) {
      const day = this.clock().toISOString().slice(0, 10);
      this.ledger.lock(m.thread, m.from, m.to, day);
    }
    this.queue.push(signed);
  }

  // Доставляє чергу. limit дозволяє доставити лише кілька повідомлень (для тестів і покрокового демо).
  flush(limit = Infinity): number {
    let n = 0;
    while (this.queue.length > 0 && n < limit) {
      if (++n > 10_000) throw new NetworkError('Забагато повідомлень за один прохід');
      const msg = this.queue.shift()!;
      this.trace.push(msg);
      this.endpoints.get(msg.payload.to)!.receive(msg);
    }
    return n;
  }
}
