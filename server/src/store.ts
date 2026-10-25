import type { EmbassyState, LedgerState } from '../../core/src/index.ts';

export interface StoredEmbassy {
  id: string;
  state: EmbassyState;
  agentKeyEnc: string;
}

// Усе, що змінив один запит. Записується однією транзакцією: або все, або нічого.
export interface Commit {
  embassies: StoredEmbassy[];
  ledger: LedgerState;
  nonce?: { sigHash: string; embassy: string; op: string };
  stripeEvent?: { id: string; type: string; outcome: string };
}

export interface Store {
  migrate(): Promise<void>;
  load(): Promise<{ embassies: StoredEmbassy[]; ledger?: LedgerState }>;
  hasNonce(sigHash: string): Promise<boolean>;
  hasStripeEvent(id: string): Promise<boolean>;
  commit(c: Commit): Promise<void>;
  close(): Promise<void>;
}

// Сховище в пам'яті: для тестів і локального запуску без бази.
// Зберігає JSON-рядки, а не об'єкти, щоб поводитись як справжня база.
export class MemoryStore implements Store {
  embassies = new Map<string, string>();
  ledger?: string;
  nonces = new Set<string>();
  stripeEvents = new Map<string, string>();
  // Для тестів: наступний commit впаде, як при збої бази.
  failNext = false;

  async migrate(): Promise<void> {}

  async load() {
    return {
      embassies: [...this.embassies.values()].map((s) => JSON.parse(s) as StoredEmbassy),
      ledger: this.ledger ? (JSON.parse(this.ledger) as LedgerState) : undefined,
    };
  }

  async hasNonce(sigHash: string): Promise<boolean> {
    return this.nonces.has(sigHash);
  }

  async hasStripeEvent(id: string): Promise<boolean> {
    return this.stripeEvents.has(id);
  }

  async commit(c: Commit): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Збій бази (тест)');
    }
    if (c.nonce && this.nonces.has(c.nonce.sigHash)) throw new Error('Підпис уже використано');
    if (c.stripeEvent && this.stripeEvents.has(c.stripeEvent.id)) throw new Error('Подію Stripe уже оброблено');
    for (const e of c.embassies) this.embassies.set(e.id, JSON.stringify(e));
    this.ledger = JSON.stringify(c.ledger);
    if (c.nonce) this.nonces.add(c.nonce.sigHash);
    if (c.stripeEvent) this.stripeEvents.set(c.stripeEvent.id, c.stripeEvent.outcome);
  }

  async close(): Promise<void> {}
}
