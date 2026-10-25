import { createHash } from 'node:crypto';
import {
  AuthError,
  Embassy,
  Switchboard,
  exportPrivateKey,
  importKeyPair,
  importPublicKey,
  newKeyPair,
  restoreEmbassy,
  restoreLedger,
  snapshotEmbassy,
  snapshotLedger,
  verifySigned,
} from '../../core/src/index.ts';
import type { CheckoutProvider, Signed } from '../../core/src/index.ts';
import type { Commit, Store, StoredEmbassy } from './store.ts';
import type { Vault } from './vault.ts';

// Скільки триває підпис людини. Старіший запит відкидається, навіть якщо підпис справжній.
export const SIGNATURE_TTL_MS = 10 * 60 * 1000;
export const STARTER_CREDITS = 20;

export class NotFoundError extends Error {}
export class ReplayError extends Error {}

export interface Registration {
  embassy: string;
  op: 'register';
  name: string;
  humanPublicKey: string;
}

export interface WorldOptions {
  store: Store;
  vault: Vault;
  checkout?: CheckoutProvider;
  clock?: () => Date;
}

// Мережа посольств у пам'яті процесу, яка після кожної зміни записується в базу.
// Запити виконуються по одному: стан ядра не розрахований на паралельні зміни.
export class World {
  store: Store;
  vault: Vault;
  checkout?: CheckoutProvider;
  clock: () => Date;
  net: Switchboard;
  embassies = new Map<string, Embassy>();
  // Останній записаний у базу стан: з нього відкочуємось, якщо запит упав посередині.
  saved = new Map<string, StoredEmbassy>();
  savedLedger = '';
  queue: Promise<unknown> = Promise.resolve();

  constructor(o: WorldOptions) {
    this.store = o.store;
    this.vault = o.vault;
    this.checkout = o.checkout;
    this.clock = o.clock ?? (() => new Date());
    this.net = new Switchboard(this.clock);
  }

  static async open(o: WorldOptions): Promise<World> {
    const w = new World(o);
    await w.store.migrate();
    const { embassies, ledger } = await w.store.load();
    if (ledger) restoreLedger(w.net.ledger, ledger);
    w.savedLedger = JSON.stringify(snapshotLedger(w.net.ledger));
    for (const s of embassies) w.revive(s);
    return w;
  }

  revive(s: StoredEmbassy): Embassy {
    this.net.endpoints.delete(s.id);
    this.net.unlistShop(s.id);
    const agentKeys = importKeyPair(this.vault.open(s.agentKeyEnc, s.id));
    const e = restoreEmbassy(s.state, { net: this.net, agentKeys, checkout: this.checkout, clock: this.clock });
    this.embassies.set(s.id, e);
    this.saved.set(s.id, s);
    return e;
  }

  get(id: string): Embassy {
    const e = this.embassies.get(id);
    if (!e) throw new NotFoundError(`Немає посольства ${id}`);
    return e;
  }

  // Перевіряє, що підпис людини свіжий і ще не використаний. Сам підпис перевіряє ядро.
  async checkFresh(signed: Signed<unknown>): Promise<string> {
    const at = Date.parse(signed.signedAt);
    if (!Number.isFinite(at) || Math.abs(this.clock().getTime() - at) > SIGNATURE_TTL_MS) {
      throw new AuthError('Підпис застарів або має неправильний час');
    }
    const sigHash = createHash('sha256').update(signed.sig).digest('hex');
    if (await this.store.hasNonce(sigHash)) throw new ReplayError('Цей підпис уже використано');
    return sigHash;
  }

  // Читання депеші й журналу: людина підписує {embassy, op:'read'}; підпис живе 5 хвилин.
  authorizeRead(id: string, token: Signed<{ embassy: string; op: string }> | undefined): Embassy {
    const e = this.get(id);
    if (!token || token.payload?.op !== 'read' || token.payload.embassy !== id) throw new AuthError('Потрібен підпис людини для читання');
    const at = Date.parse(token.signedAt);
    if (!Number.isFinite(at) || Math.abs(this.clock().getTime() - at) > 5 * 60 * 1000) throw new AuthError('Підпис для читання застарів');
    if (!verifySigned(token, e.humanPublicKey, 'human')) throw new AuthError('Потрібен підпис людини для читання');
    return e;
  }

  // Виконує зміну, доставляє повідомлення між послами і записує все однією транзакцією.
  // Якщо щось упало (у ядрі або в базі), стан у пам'яті повертається до записаного.
  mutate<T>(touch: string[], fn: () => T | Promise<T>, extra: Pick<Commit, 'nonce' | 'stripeEvent'> = {}): Promise<T> {
    const run = async (): Promise<T> => {
      const touched = new Set(touch);
      try {
        const result = await fn();
        this.net.flush();
        for (const s of this.net.trace) touched.add(s.payload.to).add(s.payload.from);
        this.net.trace = [];
        const changed: StoredEmbassy[] = [];
        for (const id of touched) {
          const e = this.embassies.get(id);
          if (!e) continue;
          const prev = this.saved.get(id);
          const state = snapshotEmbassy(e);
          if (prev && JSON.stringify(prev.state) === JSON.stringify(state)) continue;
          changed.push({ id, state, agentKeyEnc: prev?.agentKeyEnc ?? this.vault.seal(exportPrivateKey(e.agentKeys.privateKey), id) });
        }
        const ledger = snapshotLedger(this.net.ledger);
        await this.store.commit({ embassies: changed, ledger, ...extra });
        for (const s of changed) this.saved.set(s.id, s);
        this.savedLedger = JSON.stringify(ledger);
        return result;
      } catch (err) {
        this.rollback(touched);
        throw err;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  rollback(touched: Set<string>): void {
    this.net.queue = [];
    for (const s of this.net.trace) touched.add(s.payload.to).add(s.payload.from);
    this.net.trace = [];
    for (const id of touched) {
      const s = this.saved.get(id);
      if (s) this.revive(s);
      else if (this.embassies.has(id)) {
        // Посольство створено в цьому ж запиті і ще не записане: прибираємо його.
        this.embassies.delete(id);
        this.net.endpoints.delete(id);
        this.net.unlistShop(id);
      }
    }
    restoreLedger(this.net.ledger, JSON.parse(this.savedLedger || '{"balances":[],"locks":[],"daily":[]}'));
  }

  async register(signed: Signed<Registration>): Promise<Embassy> {
    const r = signed.payload;
    if (r?.op !== 'register' || typeof r.embassy !== 'string' || !/^[a-z0-9-]{3,32}$/.test(r.embassy)) {
      throw new AuthError('Ідентифікатор посольства: 3–32 символи a-z, 0-9, «-»');
    }
    if (typeof r.name !== 'string' || r.name.trim().length < 1 || r.name.length > 80) throw new AuthError('Ім’я від 1 до 80 символів');
    let humanKey;
    try {
      humanKey = importPublicKey(r.humanPublicKey);
    } catch {
      throw new AuthError('Неправильний публічний ключ людини');
    }
    // Людина доводить, що ключ її: реєстрацію підписано тим самим ключем.
    if (!verifySigned(signed, humanKey, 'human')) throw new AuthError('Реєстрацію має підписати ключ людини');
    const nonce = await this.checkFresh(signed);
    return this.mutate(
      [r.embassy],
      () => {
        if (this.embassies.has(r.embassy)) throw new AuthError('Таке посольство вже існує');
        const e = new Embassy({
          id: r.embassy, name: r.name.trim(), humanPublicKey: humanKey, net: this.net,
          agentKeys: newKeyPair(), checkout: this.checkout, clock: this.clock,
        });
        this.embassies.set(e.id, e);
        this.net.ledger.credit(e.id, STARTER_CREDITS);
        return e;
      },
      { nonce: { sigHash: nonce, embassy: r.embassy, op: 'register' } },
    );
  }

  // Команда людини: перевірка свіжості, виконання в ядрі (там перевіряється підпис), запис.
  async command<T>(id: string, op: string, signed: Signed<{ embassy: string }>, fn: (e: Embassy) => T | Promise<T>): Promise<T> {
    this.get(id);
    if (!signed || typeof signed !== 'object' || !signed.payload) throw new AuthError('Потрібна підписана команда');
    const nonce = await this.checkFresh(signed);
    // Беремо посольство заново всередині черги: попередній запит міг його відкотити.
    return this.mutate([id], () => fn(this.get(id)), { nonce: { sigHash: nonce, embassy: id, op } });
  }
}
