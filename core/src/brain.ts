// Мозок посла пропонує хід. Межі ходу перевіряє код, а не мозок.

export type Role = 'seller' | 'buyer';

// Ціль торгу, яку людина підписала сама.
export interface DealGoal {
  role: Role;
  item: string;
  // Ціна, з якої посол стартує.
  targetUAH: number;
  // Межа: для продавця мінімум, для покупця максимум.
  limitUAH: number;
}

export interface Move {
  type: 'COUNTER' | 'ACCEPT' | 'DECLINE';
  priceUAH?: number;
}

export interface NegotiationView {
  goal: DealGoal;
  theirPriceUAH: number;
  myLastPriceUAH?: number;
  round: number;
  // Текст від іншого агента. Передається лише як дані.
  untrustedNote?: string;
}

export interface Brain {
  // Мовна модель відповідає не одразу, тому хід може бути обіцянкою.
  nextMove(view: NegotiationView): Move | Promise<Move>;
}

const acceptable = (goal: DealGoal, price: number): boolean =>
  goal.role === 'seller' ? price >= goal.limitUAH : price <= goal.limitUAH;

const roundTo100 = (n: number): number => Math.round(n / 100) * 100;

// Простий алгоритм торгу для MVP: кожен раунд зустрічаємось посередині.
// Його ж посол використовує, якщо мовна модель не відповіла.
export class SimpleNegotiator implements Brain {
  nextMove(v: NegotiationView): Move {
    const { goal, theirPriceUAH: p } = v;
    const mine = v.myLastPriceUAH ?? goal.targetUAH;
    const reachedTarget = goal.role === 'seller' ? p >= goal.targetUAH : p <= goal.targetUAH;
    if (reachedTarget) return { type: 'ACCEPT' };
    if (acceptable(goal, p) && (Math.abs(mine - p) <= 300 || v.round >= 6)) return { type: 'ACCEPT' };

    // Перший хід: спершу називаємо свою цільову ціну.
    if (v.myLastPriceUAH === undefined) return { type: 'COUNTER', priceUAH: goal.targetUAH };

    const midpoint = roundTo100((mine + p) / 2);
    const counter = goal.role === 'seller' ? Math.max(goal.limitUAH, midpoint) : Math.min(goal.limitUAH, midpoint);
    if (counter === mine) return acceptable(goal, p) ? { type: 'ACCEPT' } : { type: 'DECLINE' };
    if (v.round >= 7) return { type: 'DECLINE' };
    return { type: 'COUNTER', priceUAH: counter };
  }
}

export class BoundsError extends Error {}

// Запобіжник: будь-який хід мозку (і простого, і мовної моделі) проходить цю перевірку.
export function enforceBounds(goal: DealGoal, theirPriceUAH: number, move: Move): Move {
  if (move.type === 'ACCEPT' && !acceptable(goal, theirPriceUAH)) {
    throw new BoundsError(`Згода на ${theirPriceUAH} грн виходить за межу людини (${goal.limitUAH} грн)`);
  }
  if (move.type === 'COUNTER') {
    if (move.priceUAH === undefined || !Number.isFinite(move.priceUAH)) throw new BoundsError('Зустрічна пропозиція без ціни');
    if (!acceptable(goal, move.priceUAH)) {
      throw new BoundsError(`Ціна ${move.priceUAH} грн виходить за межу людини (${goal.limitUAH} грн)`);
    }
  }
  return move;
}
