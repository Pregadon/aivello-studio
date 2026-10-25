import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HumanDevice, StripeCheckout, exportPublicKey } from '../../core/src/index.ts';
import type { Brain } from '../../core/src/index.ts';
import { createHandler } from '../src/http.ts';
import { MemoryStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import { Vault } from '../src/vault.ts';
import { World } from '../src/world.ts';

export const WEBHOOK_SECRET = 'whsec_test';
export const MASTER_KEY = randomBytes(32).toString('hex');

// Підмінений Stripe: кожна сесія отримує свій номер.
export function fakeStripe() {
  let n = 0;
  const calls: URLSearchParams[] = [];
  const provider = new StripeCheckout('sk_test_x', async (_url, init) => {
    calls.push(new URLSearchParams(init.body));
    n++;
    return { ok: true, status: 200, json: async () => ({ id: `cs_test_${n}`, url: `https://checkout.stripe.com/c/pay/cs_test_${n}` }) };
  });
  return { provider, calls };
}

export async function startServer(store: Store = new MemoryStore(), o: { brain?: Brain } = {}) {
  const stripe = fakeStripe();
  const world = await World.open({ store, vault: new Vault(MASTER_KEY), checkout: stripe.provider, brain: o.brain });
  const logs: string[] = [];
  const server = createServer(createHandler({ world, stripeWebhookSecret: WEBHOOK_SECRET, log: (m) => logs.push(m) }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  async function webhook(event: object, secret = WEBHOOK_SECRET) {
    const raw = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
    return call('POST', '/v1/stripe/webhook', raw, { 'stripe-signature': `t=${t},v1=${sig}` });
  }

  const close = () => new Promise<void>((r) => server.close(() => r()));
  return { world, store, stripe, call, webhook, close, logs };
}

// Людина з телефоном: підписує команди й токени читання.
export class Person {
  device: HumanDevice;
  id: string;
  constructor(id: string, name = id) {
    this.id = id;
    this.device = new HumanDevice(name);
  }
  register() {
    return this.device.sign({ embassy: this.id, op: 'register', name: this.device.name, humanPublicKey: exportPublicKey(this.device.publicKey) });
  }
  sign<T extends object>(payload: T) {
    return this.device.sign({ embassy: this.id, ...payload });
  }
  readHeader() {
    return { authorization: `Posol ${Buffer.from(JSON.stringify(this.device.sign({ embassy: this.id, op: 'read' }))).toString('base64url')}` };
  }
}

export function paidEvent(id: string, session: string, embassy: string, amount = 500) {
  return {
    id,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: session, payment_status: 'paid', amount_total: amount, currency: 'usd', created: Math.floor(Date.now() / 1000),
        metadata: { embassy, purpose: 'shop_publish' },
      },
    },
  };
}
