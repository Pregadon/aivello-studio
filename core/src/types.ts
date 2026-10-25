// Сфери, в яких посол може діяти від імені людини.
export type Domain =
  | 'feed'
  | 'inbox'
  | 'meetings'
  | 'posts'
  | 'replies'
  | 'deals'
  | 'personal'
  | 'legal';

// 0 — дивиться, 1 — пропонує, 2 — діє сам, 3 — тільки людина.
export type Level = 0 | 1 | 2 | 3;

export const LEVEL_NAMES: Record<Level, string> = {
  0: 'Дивиться',
  1: 'Пропонує',
  2: 'Діє сам',
  3: 'Тільки людина',
};

export interface DomainRule {
  level: Level;
  // Закріплено платформою: змінити не може ніхто, навіть людина.
  locked?: boolean;
  // Вище цієї суми посол лише пропонує.
  maxAmountUAH?: number;
  // Самостійно діє лише з людьми з кола довіри.
  trustedOnly?: boolean;
}

export type Mandate = Record<Domain, DomainRule>;

// Намір: те, що посол хоче зробити. Сам по собі нічого не робить.
export interface Intent {
  domain: Domain;
  action: string;
  summary: string;
  counterparty?: string;
  amountUAH?: number;
  // Тільки читання (підсумувати, відфільтрувати): дозволено навіть у тиші.
  readOnly?: boolean;
  // Хід у межах цілі, яку людина підписала сама (наприклад, торг до мінімальної ціни).
  withinHumanGoal?: boolean;
}

export type Verdict = 'execute' | 'propose' | 'deny';

export interface Decision {
  verdict: Verdict;
  rule: string;
  reason: string;
}

export interface PolicyContext {
  quiet: boolean;
  isTrusted: (embassyId: string) => boolean;
}
