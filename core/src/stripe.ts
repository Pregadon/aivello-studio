import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Receipt } from './shop.ts';

// Оплата публікації магазину через Stripe Checkout.
// Потік: створюємо сесію оплати → людина платить на сторінці Stripe →
// Stripe надсилає вебхук checkout.session.completed → перевіряємо підпис → публікуємо магазин.
// Без SDK: два виклики REST API і HMAC-перевірка вебхука.

export interface CheckoutSession {
  id: string;
  url: string;
}

export interface CheckoutRequest {
  embassy: string;
  amountCents: number;
  currency: string;
  productName: string;
  successUrl: string;
  cancelUrl: string;
  // Той самий ключ при повторі запиту не створить другу сесію.
  idempotencyKey: string;
}

export interface CheckoutProvider {
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
}

export class StripeError extends Error {}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export class StripeCheckout implements CheckoutProvider {
  secretKey: string;
  fetch: FetchLike;
  apiBase: string;

  constructor(secretKey: string, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike, apiBase = 'https://api.stripe.com') {
    if (!secretKey.startsWith('sk_')) throw new StripeError('Потрібен секретний ключ Stripe (sk_test_… або sk_live_…)');
    this.secretKey = secretKey;
    this.fetch = fetchImpl;
    this.apiBase = apiBase;
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const form = new URLSearchParams({
      mode: 'payment',
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
      client_reference_id: req.embassy,
      'metadata[embassy]': req.embassy,
      'metadata[purpose]': 'shop_publish',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': req.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(req.amountCents),
      'line_items[0][price_data][product_data][name]': req.productName,
    });
    const res = await this.fetch(`${this.apiBase}/v1/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': req.idempotencyKey,
      },
      body: form.toString(),
    });
    const data = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
    if (!res.ok || !data.id || !data.url) {
      throw new StripeError(`Stripe відхилив створення оплати (${res.status}): ${data.error?.message ?? 'без пояснення'}`);
    }
    return { id: data.id, url: data.url };
  }
}

export const WEBHOOK_TOLERANCE_SEC = 300;

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

// Перевіряє заголовок Stripe-Signature: t=<час>,v1=<hmac>. Підробити подію без секрету вебхука неможливо.
export function verifyStripeWebhook(
  rawBody: string,
  signatureHeader: string,
  endpointSecret: string,
  nowSec = Math.floor(Date.now() / 1000),
): StripeEvent {
  const parts = new Map<string, string[]>();
  for (const item of signatureHeader.split(',')) {
    const [k, v] = item.split('=', 2);
    if (k && v) parts.set(k.trim(), [...(parts.get(k.trim()) ?? []), v.trim()]);
  }
  const t = Number(parts.get('t')?.[0]);
  const candidates = parts.get('v1') ?? [];
  if (!Number.isFinite(t) || candidates.length === 0) throw new StripeError('Неправильний заголовок Stripe-Signature');
  if (Math.abs(nowSec - t) > WEBHOOK_TOLERANCE_SEC) throw new StripeError('Вебхук застарів');

  const expected = createHmac('sha256', endpointSecret).update(`${t}.${rawBody}`, 'utf8').digest();
  const ok = candidates.some((hex) => {
    const got = Buffer.from(hex, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!ok) throw new StripeError('Підпис вебхука не збігається');
  return JSON.parse(rawBody) as StripeEvent;
}

// Перетворює оплачену сесію Checkout на чек для магазину. Інші події ігнорує.
export function receiptFromCheckoutEvent(event: StripeEvent): (Receipt & { sessionId: string }) | undefined {
  if (event.type !== 'checkout.session.completed') return undefined;
  const s = event.data.object as {
    id?: string;
    payment_status?: string;
    amount_total?: number;
    currency?: string;
    created?: number;
    metadata?: { embassy?: string; purpose?: string };
  };
  if (s.payment_status !== 'paid' || s.metadata?.purpose !== 'shop_publish') return undefined;
  if (!s.id || !s.metadata.embassy || typeof s.amount_total !== 'number' || !s.currency) {
    throw new StripeError('У події оплати бракує полів');
  }
  return {
    id: event.id,
    sessionId: s.id,
    embassy: s.metadata.embassy,
    amountCents: s.amount_total,
    currency: s.currency.toUpperCase(),
    paidAt: new Date((s.created ?? 0) * 1000).toISOString(),
  };
}
