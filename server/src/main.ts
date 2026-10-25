// Запуск: DATABASE_URL=… POSOL_MASTER_KEY=… STRIPE_SECRET_KEY=… STRIPE_WEBHOOK_SECRET=… npm start
import { createServer } from 'node:http';
import { StripeCheckout } from '../../core/src/index.ts';
import { ClaudeBrain } from './claude-brain.ts';
import { createHandler } from './http.ts';
import { PgStore } from './pg-store.ts';
import { MemoryStore } from './store.ts';
import type { Store } from './store.ts';
import { Vault } from './vault.ts';
import { World } from './world.ts';

const env = process.env;
if (!env.POSOL_MASTER_KEY) {
  console.error('Потрібен POSOL_MASTER_KEY: 64 hex-символи. Згенерувати: openssl rand -hex 32');
  process.exit(1);
}

let store: Store;
if (env.DATABASE_URL) {
  store = new PgStore(env.DATABASE_URL);
} else {
  console.warn('DATABASE_URL не задано: дані зберігаються лише в пам’яті й зникнуть після зупинки.');
  store = new MemoryStore();
}

const checkout = env.STRIPE_SECRET_KEY ? new StripeCheckout(env.STRIPE_SECRET_KEY) : undefined;
if (!checkout) console.warn('STRIPE_SECRET_KEY не задано: оплата публікації магазину недоступна.');
if (!env.STRIPE_WEBHOOK_SECRET) console.warn('STRIPE_WEBHOOK_SECRET не задано: вебхук Stripe відповідатиме 503.');

// POSOL_BRAIN=claude вмикає мозок на Claude, simple — простий алгоритм. За замовчуванням Claude, якщо є ключ.
const brainKind = env.POSOL_BRAIN ?? (env.ANTHROPIC_API_KEY ? 'claude' : 'simple');
if (brainKind !== 'claude' && brainKind !== 'simple') {
  console.error('POSOL_BRAIN має бути claude або simple');
  process.exit(1);
}
const brain = brainKind === 'claude' ? new ClaudeBrain({ model: env.POSOL_MODEL }) : undefined;
console.log(brain ? `Мозок послів: Claude (${brain.model})` : 'Мозок послів: простий алгоритм торгу');

const world = await World.open({ store, vault: new Vault(env.POSOL_MASTER_KEY), checkout, brain });
const server = createServer(createHandler({ world, stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET }));
const port = Number(env.PORT ?? 8080);
server.listen(port, () => console.log(`Посол слухає на :${port}, посольств: ${world.embassies.size}`));

const stop = () => {
  server.close(async () => {
    await world.queue;
    await store.close();
    process.exit(0);
  });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
