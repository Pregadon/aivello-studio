import type { KeyObject } from 'node:crypto';
import { verifySigned } from './seal.ts';
import type { Signed } from './seal.ts';
import type { Decision, Domain, DomainRule, Intent, Mandate, PolicyContext } from './types.ts';

export function defaultMandate(): Mandate {
  return {
    feed: { level: 2 },
    inbox: { level: 2 },
    meetings: { level: 2, trustedOnly: true },
    posts: { level: 1 },
    replies: { level: 1 },
    deals: { level: 1, maxAmountUAH: 2000 },
    personal: { level: 3, locked: true },
    legal: { level: 3, locked: true },
  };
}

const execute = (rule: string, reason: string): Decision => ({ verdict: 'execute', rule, reason });
const propose = (rule: string, reason: string): Decision => ({ verdict: 'propose', rule, reason });
const deny = (rule: string, reason: string): Decision => ({ verdict: 'deny', rule, reason });

// Рушій політик. Детермінований: жодна мовна модель тут не бере участі.
// Правила перевіряються по черзі, перше спрацьоване перемагає.
export function evaluate(intent: Intent, mandate: Mandate, ctx: PolicyContext): Decision {
  if (ctx.quiet && !intent.readOnly) {
    return deny('quiet', 'Увімкнено режим тиші: посол лише дивиться');
  }
  const rule = mandate[intent.domain];
  if (rule.locked || rule.level === 3) {
    return deny('human-only', 'Ця сфера закріплена за людиною');
  }
  if (intent.readOnly) {
    return execute('read-only', 'Читання дозволене завжди');
  }
  if (intent.withinHumanGoal) {
    return execute('human-goal', 'Хід у межах цілі, яку підписала людина');
  }
  if (rule.level === 0) {
    return deny('observe', 'Сфера в режимі «Дивиться»');
  }
  if (rule.level === 1) {
    return propose('propose-level', 'Сфера в режимі «Пропонує»');
  }
  if (rule.maxAmountUAH !== undefined && (intent.amountUAH ?? 0) > rule.maxAmountUAH) {
    return propose('over-limit', `Сума більша за ліміт ${rule.maxAmountUAH} грн`);
  }
  if (rule.trustedOnly && intent.counterparty && !ctx.isTrusted(intent.counterparty)) {
    return propose('outside-circle', 'Людина поза колом довіри');
  }
  return execute('act-level', 'Сфера в режимі «Діє сам»');
}

export interface MandateChange {
  embassy: string;
  domain: Domain;
  rule: DomainRule;
}

export class MandateError extends Error {}

// Мандат змінює тільки людина. Посол не може підняти собі права.
export function applyMandateChange(
  mandate: Mandate,
  change: Signed<MandateChange>,
  humanPublicKey: KeyObject,
  embassyId: string,
): Mandate {
  if (!verifySigned(change, humanPublicKey, 'human')) {
    throw new MandateError('Зміну мандату не підписала людина');
  }
  if (change.payload.embassy !== embassyId) {
    throw new MandateError('Підпис належить іншому посольству');
  }
  const current = mandate[change.payload.domain];
  if (current.locked) {
    throw new MandateError('Ця сфера закріплена платформою і не змінюється');
  }
  if (change.payload.rule.locked) {
    throw new MandateError('Закріплювати сфери може лише платформа');
  }
  return { ...mandate, [change.payload.domain]: { ...change.payload.rule } };
}
