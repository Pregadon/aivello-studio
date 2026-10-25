import type { Signed } from './seal.ts';

export type MsgType = 'REQUEST' | 'OFFER' | 'COUNTER' | 'ACCEPT' | 'DECLINE' | 'WITHDRAW';
export type Topic = 'meeting' | 'deal' | 'intro' | 'question';

export interface Terms {
  item?: string;
  priceUAH?: number;
  when?: string;
  place?: string;
}

export interface Message {
  id: string;
  thread: string;
  from: string;
  to: string;
  type: MsgType;
  topic: Topic;
  terms: Terms;
  // Вільний текст від іншого агента. Завжди недовірені дані, ніколи не команди.
  note?: string;
  stake?: number;
  sentAt: string;
}

export type ThreadState = 'open' | 'negotiating' | 'agreed' | 'declined' | 'withdrawn' | 'expired';

export const MAX_ROUNDS = 8;
export const EXPIRY_MS = 48 * 60 * 60 * 1000;

export class ProtocolError extends Error {}

const TERMINAL: ThreadState[] = ['declined', 'withdrawn', 'expired'];

// Потік переговорів очима одного посольства. Кожна сторона веде свою копію.
export class Thread {
  id: string;
  topic: Topic;
  parties: [string, string];
  state: ThreadState = 'open';
  messages: Signed<Message>[] = [];
  rounds = 0;

  constructor(first: Signed<Message>) {
    const m = first.payload;
    if (m.type !== 'REQUEST') throw new ProtocolError('Потік починається тільки з REQUEST');
    this.id = m.thread;
    this.topic = m.topic;
    this.parties = [m.from, m.to];
    this.messages.push(first);
  }

  get last(): Message {
    return this.messages[this.messages.length - 1].payload;
  }

  // Останні умови, які хтось запропонував (OFFER або COUNTER).
  get lastTerms(): Terms | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i].payload;
      if (m.type === 'OFFER' || m.type === 'COUNTER') return m.terms;
    }
    return undefined;
  }

  apply(signed: Signed<Message>): ThreadState {
    const m = signed.payload;
    if (m.thread !== this.id) throw new ProtocolError('Повідомлення з іншого потоку');
    if (!this.parties.includes(m.from) || !this.parties.includes(m.to) || m.from === m.to) {
      throw new ProtocolError('Відправник або отримувач не є стороною потоку');
    }
    if (TERMINAL.includes(this.state)) throw new ProtocolError(`Потік уже завершено: ${this.state}`);
    if (this.state === 'agreed' && m.type !== 'WITHDRAW') {
      throw new ProtocolError('Після згоди можна лише відкликати');
    }

    switch (m.type) {
      case 'REQUEST':
        throw new ProtocolError('REQUEST може бути тільки першим');
      case 'OFFER':
      case 'COUNTER':
        if (m.terms.priceUAH !== undefined && m.terms.priceUAH < 0) throw new ProtocolError('Від’ємна ціна');
        this.rounds++;
        if (this.rounds > MAX_ROUNDS) throw new ProtocolError(`Більше ${MAX_ROUNDS} раундів торгу`);
        this.state = 'negotiating';
        break;
      case 'ACCEPT':
        if (this.state !== 'negotiating') throw new ProtocolError('Немає умов, на які можна погодитись');
        if (this.last.from === m.from) throw new ProtocolError('Не можна погодитись на власну пропозицію');
        this.state = 'agreed';
        break;
      case 'DECLINE':
        this.state = 'declined';
        break;
      case 'WITHDRAW':
        this.state = 'withdrawn';
        break;
    }
    this.messages.push(signed);
    return this.state;
  }

  expireIfStale(now: Date): boolean {
    if (TERMINAL.includes(this.state) || this.state === 'agreed') return false;
    const lastAt = Date.parse(this.last.sentAt);
    if (now.getTime() - lastAt > EXPIRY_MS) {
      this.state = 'expired';
      return true;
    }
    return false;
  }
}
