// Вбудований магазин. Є в кожному посольстві з коробки, але вимкнений:
// людина активує його, заповнює і публікує за разову плату.

export const PUBLISH_FEE = { amountCents: 500, currency: 'USD' } as const;

export type ShopStatus = 'inactive' | 'draft' | 'published';

export interface ShopProfile {
  name: string;
  description: string;
  city?: string;
}

export interface Product {
  id: string;
  title: string;
  description: string;
  priceUAH: number;
  // Нижче цієї ціни посол не торгується. Не задано — ціна фіксована.
  minPriceUAH?: number;
  stock: number;
}

export interface Receipt {
  id: string;
  embassy: string;
  amountCents: number;
  currency: string;
  paidAt: string;
}

// Платіжний шлюз. У MVP справжню оплату (наприклад, Stripe) підключимо через цей інтерфейс.
export interface PaymentGateway {
  charge(embassy: string, amountCents: number, currency: string, memo: string): Receipt;
}

export class ShopError extends Error {}

const MAX_PRODUCTS = 200;

export class Shop {
  owner: string;
  status: ShopStatus = 'inactive';
  profile?: ShopProfile;
  products = new Map<string, Product>();
  receipt?: Receipt;
  seq = 0;

  constructor(owner: string) {
    this.owner = owner;
  }

  activate(): void {
    if (this.status !== 'inactive') throw new ShopError('Магазин уже активовано');
    this.status = 'draft';
  }

  requireActive(): void {
    if (this.status === 'inactive') throw new ShopError('Спершу активуй магазин');
  }

  setProfile(p: ShopProfile): void {
    this.requireActive();
    const name = p.name.trim();
    if (name.length < 2 || name.length > 60) throw new ShopError('Назва магазину має бути від 2 до 60 символів');
    if (p.description.trim().length < 10) throw new ShopError('Опис магазину надто короткий');
    this.profile = { ...p, name };
  }

  addProduct(p: Omit<Product, 'id'>): Product {
    this.requireActive();
    if (this.products.size >= MAX_PRODUCTS) throw new ShopError(`Не більше ${MAX_PRODUCTS} товарів`);
    const product = { ...p, id: `${this.owner}-p${++this.seq}` };
    validateProduct(product);
    if ([...this.products.values()].some((x) => x.title === product.title)) {
      throw new ShopError('Товар з такою назвою вже є');
    }
    this.products.set(product.id, product);
    return product;
  }

  updateProduct(id: string, patch: Partial<Omit<Product, 'id'>>): Product {
    this.requireActive();
    const current = this.products.get(id);
    if (!current) throw new ShopError('Немає такого товару');
    const next = { ...current, ...patch, id };
    validateProduct(next);
    this.products.set(id, next);
    return next;
  }

  removeProduct(id: string): void {
    this.requireActive();
    if (!this.products.delete(id)) throw new ShopError('Немає такого товару');
  }

  // Чого бракує до публікації. Порожній список — можна публікувати.
  missing(): string[] {
    const out: string[] = [];
    if (this.status === 'inactive') out.push('активувати магазин');
    if (!this.profile) out.push('назва й опис магазину');
    if (this.products.size === 0) out.push('хоча б один товар');
    return out;
  }

  get feePaid(): boolean {
    return this.receipt !== undefined;
  }

  // Плата разова: повторна публікація після змін безкоштовна.
  publish(receipt?: Receipt): void {
    const gaps = this.missing();
    if (gaps.length) throw new ShopError(`Бракує: ${gaps.join(', ')}`);
    if (this.status === 'published') return;
    const paid = this.receipt ?? receipt;
    if (!paid) throw new ShopError('Публікація коштує $5');
    if (paid.embassy !== this.owner || paid.currency !== PUBLISH_FEE.currency || paid.amountCents < PUBLISH_FEE.amountCents) {
      throw new ShopError('Чек не підходить для оплати публікації');
    }
    this.receipt = paid;
    this.status = 'published';
  }

  unpublish(): void {
    if (this.status !== 'published') throw new ShopError('Магазин не опубліковано');
    this.status = 'draft';
  }

  // Товари, які зараз можна купити.
  inStock(): Product[] {
    return [...this.products.values()].filter((p) => p.stock > 0);
  }
}

function validateProduct(p: Product): void {
  if (p.title.trim().length < 2) throw new ShopError('Назва товару надто коротка');
  if (!Number.isInteger(p.priceUAH) || p.priceUAH <= 0) throw new ShopError('Ціна має бути цілою додатною сумою в гривнях');
  if (p.minPriceUAH !== undefined && (!Number.isInteger(p.minPriceUAH) || p.minPriceUAH <= 0 || p.minPriceUAH > p.priceUAH)) {
    throw new ShopError('Мінімальна ціна має бути від 1 грн до ціни товару');
  }
  if (!Number.isInteger(p.stock) || p.stock < 0) throw new ShopError('Залишок має бути цілим числом від 0');
}

// Тестовий шлюз: «списує» гроші без реальної оплати.
export class FakePaymentGateway implements PaymentGateway {
  charges: Receipt[] = [];

  charge(embassy: string, amountCents: number, currency: string, _memo: string): Receipt {
    const r = { id: `rcpt-${this.charges.length + 1}`, embassy, amountCents, currency, paidAt: new Date().toISOString() };
    this.charges.push(r);
    return r;
  }
}
