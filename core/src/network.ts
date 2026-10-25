import type { KeyObject } from 'node:crypto';
import { AttentionLedger } from './attention.ts';
import type { Message } from './protocol.ts';
import type { Product, Shop } from './shop.ts';
import { verifySigned } from './seal.ts';
import type { Signed } from './seal.ts';

export interface Endpoint {
  id: string;
  agentPublicKey: KeyObject;
  isTrusted(embassyId: string): boolean;
  receive(msg: Signed<Message>): void | Promise<void>;
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

  shops = new Map<string, Shop>();

  listShop(owner: string, shop: Shop): void {
    this.shops.set(owner, shop);
  }

  unlistShop(owner: string): void {
    this.shops.delete(owner);
  }

  // Каталог опублікованих магазинів: те, що бачать посли покупців.
  searchProducts(query: string): { embassy: string; shop: string; product: Product }[] {
    const q = query.trim().toLowerCase();
    const out: { embassy: string; shop: string; product: Product }[] = [];
    for (const [embassy, shop] of this.shops) {
      if (shop.status !== 'published') continue;
      for (const product of shop.inStock()) {
        if (`${product.title} ${product.description}`.toLowerCase().includes(q)) {
          out.push({ embassy, shop: shop.profile!.name, product });
        }
      }
    }
    return out;
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
  // Відповіді доставляються по одній: поки мозок посла думає, наступне повідомлення чекає.
  async flush(limit = Infinity): Promise<number> {
    let n = 0;
    while (this.queue.length > 0 && n < limit) {
      if (++n > 10_000) throw new NetworkError('Забагато повідомлень за один прохід');
      const msg = this.queue.shift()!;
      this.trace.push(msg);
      await this.endpoints.get(msg.payload.to)!.receive(msg);
    }
    return n;
  }
}
