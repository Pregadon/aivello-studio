export const FIRST_CONTACT_STAKE = 5;
export const NEW_CONTACTS_PER_DAY = 20;

export class AttentionError extends Error {}

interface Lock {
  from: string;
  to: string;
  amount: number;
}

// Застава за увагу: щоб написати незнайомій людині, посол блокує кредити.
// Корисний запит — кредити повертаються, спам — переходять отримувачу.
export class AttentionLedger {
  balances = new Map<string, number>();
  locks = new Map<string, Lock>();
  daily = new Map<string, number>();

  credit(embassy: string, amount: number): void {
    this.balances.set(embassy, this.balance(embassy) + amount);
  }

  balance(embassy: string): number {
    return this.balances.get(embassy) ?? 0;
  }

  lock(thread: string, from: string, to: string, day: string, amount = FIRST_CONTACT_STAKE): void {
    const key = `${from}:${day}`;
    const used = this.daily.get(key) ?? 0;
    if (used >= NEW_CONTACTS_PER_DAY) throw new AttentionError('Ліміт нових контактів на сьогодні вичерпано');
    if (this.balance(from) < amount) throw new AttentionError('Недостатньо кредитів для застави');
    this.balances.set(from, this.balance(from) - amount);
    this.locks.set(thread, { from, to, amount });
    this.daily.set(key, used + 1);
  }

  hasLock(thread: string): boolean {
    return this.locks.has(thread);
  }

  // Викликає лише отримувач запиту.
  resolve(thread: string, by: string, useful: boolean): void {
    const l = this.locks.get(thread);
    if (!l) throw new AttentionError('Для цього потоку немає застави');
    if (l.to !== by) throw new AttentionError('Оцінити запит може лише отримувач');
    this.credit(useful ? l.from : l.to, l.amount);
    this.locks.delete(thread);
  }
}
