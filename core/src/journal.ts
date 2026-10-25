export const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

export type Actor = 'agent' | 'human' | 'system';
export type EntryKind = 'executed' | 'proposed' | 'denied' | 'decided' | 'undone' | 'received';

export interface Entry {
  id: number;
  at: Date;
  actor: Actor;
  kind: EntryKind;
  summary: string;
  reason: string;
  rule?: string;
  undoUntil?: Date;
  undone?: boolean;
}

export interface NewEntry {
  actor: Actor;
  kind: EntryKind;
  summary: string;
  reason: string;
  rule?: string;
  // Як скасувати дію. Без неї запис не скасовується.
  compensate?: () => void;
}

export class JournalError extends Error {}

// Журнал лише доповнюється. Скасування додає новий запис, а не стирає старий.
export class Journal {
  entries: Entry[] = [];
  compensations = new Map<number, () => void>();
  nextId = 1;
  clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  record(e: NewEntry): Entry {
    const at = this.clock();
    const entry: Entry = {
      id: this.nextId++,
      at,
      actor: e.actor,
      kind: e.kind,
      summary: e.summary,
      reason: e.reason,
      rule: e.rule,
      undoUntil: e.compensate ? new Date(at.getTime() + UNDO_WINDOW_MS) : undefined,
    };
    if (e.compensate) this.compensations.set(entry.id, e.compensate);
    this.entries.push(entry);
    return entry;
  }

  undo(id: number): Entry {
    const entry = this.entries.find((x) => x.id === id);
    const compensate = this.compensations.get(id);
    if (!entry || !compensate || !entry.undoUntil) throw new JournalError('Цю дію не можна скасувати');
    if (entry.undone) throw new JournalError('Дію вже скасовано');
    if (this.clock() > entry.undoUntil) throw new JournalError('Минуло 24 години, скасування більше недоступне');
    compensate();
    entry.undone = true;
    this.compensations.delete(id);
    return this.record({ actor: 'human', kind: 'undone', summary: `Скасовано: ${entry.summary}`, reason: 'Рішення людини' });
  }

  since(t: Date): Entry[] {
    return this.entries.filter((e) => e.at >= t);
  }
}
