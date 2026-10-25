// Знімок стану посольства: усе, що треба зберегти в базі, щоб пережити перезапуск сервера.
// Ключі посла сюди не входять: сервер зберігає їх окремо і зашифрованими.
import type { AttentionLedger } from './attention.ts';
import type { DealGoal } from './brain.ts';
import { Embassy } from './embassy.ts';
import type { Action, Commitment, EmbassyOptions } from './embassy.ts';
import type { Entry } from './journal.ts';
import type { Switchboard } from './network.ts';
import { Thread } from './protocol.ts';
import type { Message, ThreadState, Topic } from './protocol.ts';
import { exportPublicKey, importPublicKey } from './seal.ts';
import type { Signed } from './seal.ts';
import type { Product, Receipt, ShopProfile, ShopStatus } from './shop.ts';
import type { Intent, Mandate } from './types.ts';

export const STATE_VERSION = 1;


export interface ThreadSnapshot {
  id: string;
  topic: Topic;
  parties: [string, string];
  state: ThreadState;
  messages: Signed<Message>[];
  rounds: number;
}

export interface EmbassyState {
  v: number;
  id: string;
  name: string;
  humanPublicKey: string;
  mandate: Mandate;
  quiet: boolean;
  trusted: string[];
  shop: { status: ShopStatus; profile?: ShopProfile; products: Product[]; receipt?: Receipt; seq: number };
  pendingCheckout?: string;
  sellerGoals: [string, DealGoal][];
  threadProducts: [string, string][];
  threadGoals: [string, DealGoal][];
  threads: ThreadSnapshot[];
  myLastPrice: [string, number][];
  commitments: [string, Commitment][];
  proposals: { id: number; intent: Intent; createdAt: string; action: Action; onReject: Action }[];
  journal: { entries: (Omit<Entry, 'at' | 'undoUntil'> & { at: string; undoUntil?: string })[]; nextId: number };
  undoActions: [number, Action][];
  seq: number;
  nextProposal: number;
}

export interface LedgerState {
  balances: [string, number][];
  locks: [string, { from: string; to: string; amount: number }][];
  daily: [string, number][];
}

// JSON без класів і замикань: знімок можна покласти в jsonb і прочитати назад без втрат.
const plain = <T>(x: T): T => structuredClone(x);

export function snapshotEmbassy(e: Embassy): EmbassyState {
  return plain({
    v: STATE_VERSION,
    id: e.id,
    name: e.name,
    humanPublicKey: exportPublicKey(e.humanPublicKey),
    mandate: e.mandate,
    quiet: e.quiet,
    trusted: [...e.trusted],
    shop: {
      status: e.shop.status,
      profile: e.shop.profile,
      products: [...e.shop.products.values()],
      receipt: e.shop.receipt,
      seq: e.shop.seq,
    },
    pendingCheckout: e.pendingCheckout,
    sellerGoals: [...e.sellerGoals],
    threadProducts: [...e.threadProducts],
    threadGoals: [...e.threadGoals],
    threads: [...e.threads.values()].map((t) => ({
      id: t.id, topic: t.topic, parties: t.parties, state: t.state, messages: t.messages, rounds: t.rounds,
    })),
    myLastPrice: [...e.myLastPrice],
    commitments: [...e.commitments],
    proposals: [...e.proposals.values()].map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
    journal: {
      entries: e.journal.entries.map((x) => ({ ...x, at: x.at.toISOString(), undoUntil: x.undoUntil?.toISOString() })),
      nextId: e.journal.nextId,
    },
    undoActions: [...e.undoActions],
    seq: e.seq,
    nextProposal: e.nextProposal,
  });
}

export type RestoreOptions = Omit<EmbassyOptions, 'id' | 'name' | 'humanPublicKey' | 'mandate'> & { net: Switchboard };

export function restoreEmbassy(raw: EmbassyState, o: RestoreOptions): Embassy {
  if (raw.v !== STATE_VERSION) throw new Error(`Невідома версія стану посольства: ${raw.v}`);
  const s = plain(raw);
  const e = new Embassy({ ...o, id: s.id, name: s.name, humanPublicKey: importPublicKey(s.humanPublicKey), mandate: s.mandate });
  e.quiet = s.quiet;
  e.trusted = new Set(s.trusted);

  e.shop.status = s.shop.status;
  e.shop.profile = s.shop.profile;
  e.shop.products = new Map(s.shop.products.map((p) => [p.id, p]));
  e.shop.receipt = s.shop.receipt;
  e.shop.seq = s.shop.seq;
  if (e.shop.status === 'published') o.net.listShop(e.id, e.shop);
  e.pendingCheckout = s.pendingCheckout;

  e.sellerGoals = new Map(s.sellerGoals);
  e.threadProducts = new Map(s.threadProducts);
  e.threadGoals = new Map(s.threadGoals);
  e.threads = new Map(
    s.threads.map((x) => {
      const t = Object.create(Thread.prototype) as Thread;
      Object.assign(t, x);
      return [x.id, t];
    }),
  );
  e.myLastPrice = new Map(s.myLastPrice);
  e.commitments = new Map(s.commitments);
  e.proposals = new Map(s.proposals.map((p) => [p.id, { ...p, createdAt: new Date(p.createdAt) }]));

  e.journal.entries = s.journal.entries.map((x) => ({
    ...x, at: new Date(x.at), undoUntil: x.undoUntil ? new Date(x.undoUntil) : undefined,
  }));
  e.journal.nextId = s.journal.nextId;
  e.undoActions = new Map(s.undoActions);
  for (const [id, action] of e.undoActions) {
    const entry = e.journal.entries.find((x) => x.id === id);
    if (entry && !entry.undone) e.journal.compensations.set(id, () => e.run(action));
  }
  e.seq = s.seq;
  e.nextProposal = s.nextProposal;
  return e;
}

export function snapshotLedger(l: AttentionLedger): LedgerState {
  return plain({ balances: [...l.balances], locks: [...l.locks], daily: [...l.daily] });
}

export function restoreLedger(l: AttentionLedger, s: LedgerState): void {
  l.balances = new Map(s.balances);
  l.locks = new Map(plain(s.locks));
  l.daily = new Map(s.daily);
}

