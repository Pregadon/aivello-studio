import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AttentionError,
  AuthError,
  JournalError,
  MandateError,
  NetworkError,
  ProtocolError,
  ShopError,
  StripeError,
  receiptFromCheckoutEvent,
  verifyStripeWebhook,
} from '../../core/src/index.ts';
import type {
  Embassy,
  GoalGrant,
  HumanDecision,
  MandateChange,
  QuietToggle,
  ShopCheckoutRequest,
  ShopCommand,
  Signed,
} from '../../core/src/index.ts';
import { NotFoundError, ReplayError } from './world.ts';
import type { Registration, World } from './world.ts';

export const MAX_BODY_BYTES = 64 * 1024;

export interface HttpOptions {
  world: World;
  stripeWebhookSecret?: string;
  log?: (msg: string) => void;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function statusOf(e: unknown): number {
  if (e instanceof HttpError) return e.status;
  if (e instanceof NotFoundError) return 404;
  if (e instanceof AuthError || e instanceof MandateError) return 403;
  if (e instanceof ReplayError) return 409;
  if (e instanceof ShopError || e instanceof ProtocolError || e instanceof AttentionError || e instanceof JournalError || e instanceof NetworkError) return 422;
  if (e instanceof StripeError) return 502;
  return 500;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Запит завеликий');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, 'Тіло запиту має бути JSON');
  }
}

// Токен читання: Authorization: Posol <base64url(JSON підписаного {embassy, op:'read'})>.
function readToken(req: IncomingMessage): Signed<{ embassy: string; op: string }> | undefined {
  const h = req.headers.authorization;
  if (!h?.startsWith('Posol ')) return undefined;
  try {
    return JSON.parse(Buffer.from(h.slice(6), 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

function view(e: Embassy) {
  return {
    id: e.id,
    name: e.name,
    quiet: e.quiet,
    mandate: e.mandate,
    shop: publicShop(e),
    proposals: [...e.proposals.values()].map((p) => ({ id: p.id, summary: p.intent.summary, domain: p.intent.domain, createdAt: p.createdAt })),
    dispatch: e.dispatch(new Date(e.clock().getTime() - 24 * 60 * 60 * 1000)),
  };
}

function publicShop(e: Embassy) {
  return {
    status: e.shop.status,
    profile: e.shop.profile,
    products: [...e.shop.products.values()].map(({ minPriceUAH: _hidden, ...p }) => p),
    feePaid: e.shop.feePaid,
    missing: e.shop.missing(),
  };
}

type Handler = (req: IncomingMessage, params: string[], url: URL) => Promise<[number, unknown]>;

export function createHandler(o: HttpOptions) {
  const { world } = o;
  const log = o.log ?? ((m: string) => console.log(m));
  const body = async <T>(req: IncomingMessage): Promise<T> => parseJson<T>(await readBody(req));

  // Команда людини: тіло — підписаний документ, op — назва для журналу підписів.
  const cmd = <T extends { embassy: string }>(op: string, fn: (e: Embassy, s: Signed<T>) => unknown | Promise<unknown>): Handler =>
    async (req, [id]) => {
      const signed = await body<Signed<T>>(req);
      const result = await world.command(id, op, signed, (e) => fn(e, signed));
      return [200, { ok: true, ...(result && typeof result === 'object' ? result : {}), embassy: view(world.get(id)) }];
    };

  const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/healthz$/, async () => [200, { ok: true }]],

    // Мінімальну ціну продавця покупцям не показуємо: інакше торг втрачає сенс.
    ['GET', /^\/v1\/catalog$/, async (_req, _p, url) => [200, {
      results: world.net.searchProducts(url.searchParams.get('q') ?? '').map(({ product: { minPriceUAH: _hidden, ...product }, ...r }) => ({ ...r, product })),
    }]],

    ['POST', /^\/v1\/embassies$/, async (req) => {
      const e = await world.register(await body<Signed<Registration>>(req));
      return [201, { embassy: view(e), agentPublicKey: e.agentPublicKey.export({ format: 'jwk' }).x }];
    }],

    ['GET', /^\/v1\/embassies\/([a-z0-9-]+)$/, async (req, [id]) => [200, { embassy: view(world.authorizeRead(id, readToken(req))) }]],

    ['GET', /^\/v1\/embassies\/([a-z0-9-]+)\/journal$/, async (req, [id], url) => {
      const e = world.authorizeRead(id, readToken(req));
      const since = new Date(url.searchParams.get('since') ?? 0);
      if (Number.isNaN(since.getTime())) throw new HttpError(400, 'Неправильний параметр since');
      return [200, { entries: e.journal.since(since) }];
    }],

    ['POST', /^\/v1\/embassies\/([a-z0-9-]+)\/shop$/, cmd<ShopCommand>('shop', (e, s) => e.manageShop(s))],

    ['POST', /^\/v1\/embassies\/([a-z0-9-]+)\/shop\/checkout$/, cmd<ShopCheckoutRequest>('checkout', async (e, s) => {
      const url = await e.startShopCheckout(s);
      return url ? { checkoutUrl: url } : { published: true };
    })],

    ['POST', /^\/v1\/embassies\/([a-z0-9-]+)\/decisions$/, cmd<HumanDecision>('decide', (e, s) => e.decide(s))],
    ['POST', /^\/v1\/embassies\/([a-z0-9-]+)\/mandate$/, cmd<MandateChange>('mandate', (e, s) => e.changeMandate(s))],
    ['POST', /^\/v1\/embassies\/([a-z0-9-]+)\/quiet$/, cmd<QuietToggle>('quiet', (e, s) => e.setQuiet(s))],
    ['POST', /^\/v1\/embassies\/([a-z0-9-]+)\/sell$/, cmd<GoalGrant>('sell', (e, s) => e.listForSale(s))],
    // Продавця вказано в підписаному документі, щоб ніхто не перенаправив покупку.
    ['POST', /^\/v1\/embassies\/([a-z0-9-]+)\/buy$/, cmd<GoalGrant & { seller: string }>('buy', (e, s) => {
      if (typeof s.payload.seller !== 'string') throw new HttpError(400, 'Вкажи продавця в підписаному документі');
      world.get(s.payload.seller);
      return { thread: e.startPurchase(s, s.payload.seller) };
    })],

    ['POST', /^\/v1\/stripe\/webhook$/, async (req) => {
      if (!o.stripeWebhookSecret) throw new HttpError(503, 'Вебхук Stripe не налаштовано');
      // Підпис рахується від сирого тіла, тому розбираємо JSON лише після перевірки.
      const raw = await readBody(req);
      let event;
      try {
        event = verifyStripeWebhook(raw, String(req.headers['stripe-signature'] ?? ''), o.stripeWebhookSecret, Math.floor(world.clock().getTime() / 1000));
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      if (await world.store.hasStripeEvent(event.id)) return [200, { received: true, duplicate: true }];
      const receipt = receiptFromCheckoutEvent(event);
      const touch = receipt ? [receipt.embassy] : [];
      let outcome = receipt ? 'published' : 'ignored';
      try {
        await world.mutate(touch, () => {
          if (receipt) world.get(receipt.embassy).completeShopCheckout(receipt);
        }, { stripeEvent: { id: event.id, type: event.type, outcome } });
      } catch (e) {
        // Справжня подія, яку ми не можемо застосувати (невідома сесія чи посольство).
        // Відповідаємо 200, щоб Stripe не повторював її днями, і записуємо причину.
        if (!(e instanceof ShopError || e instanceof NotFoundError)) throw e;
        outcome = `rejected: ${e.message}`;
        log(`Stripe ${event.id}: ${outcome}`);
        await world.mutate([], () => {}, { stripeEvent: { id: event.id, type: event.type, outcome } });
      }
      return [200, { received: true, outcome }];
    }],
  ];

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let status = 404;
    let payload: unknown = { error: 'Немає такого шляху' };
    try {
      const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (route) {
        const params = url.pathname.match(route[1])!.slice(1);
        [status, payload] = await route[2](req, params, url);
      } else if (routes.some(([, re]) => re.test(url.pathname))) {
        status = 405;
        payload = { error: 'Метод не підтримується' };
      }
    } catch (e) {
      status = statusOf(e);
      payload = { error: status === 500 ? 'Внутрішня помилка сервера' : (e as Error).message };
      if (status === 500) log(`500 ${req.method} ${url.pathname}: ${(e as Error).stack}`);
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
  };
}
