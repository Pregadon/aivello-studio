-- Схема сервера «Посла». Запускається при кожному старті, тому лише IF NOT EXISTS.

-- Стан посольства — знімок ядра (@posol/core snapshotEmbassy) у jsonb.
-- Ключ посла зберігається окремо, зашифрований майстер-ключем сервера (AES-256-GCM).
CREATE TABLE IF NOT EXISTS embassies (
  id            text PRIMARY KEY,
  state         jsonb NOT NULL,
  agent_key_enc text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Реєстр застав за увагу: один рядок на всю мережу.
CREATE TABLE IF NOT EXISTS attention_ledger (
  id    smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  state jsonb NOT NULL
);

-- Кожен підпис людини приймається один раз: повторно надіслана команда відкидається.
CREATE TABLE IF NOT EXISTS human_nonces (
  sig_hash text PRIMARY KEY,
  embassy  text NOT NULL,
  op       text NOT NULL,
  seen_at  timestamptz NOT NULL DEFAULT now()
);

-- Події Stripe, які вже оброблено. Stripe повторює доставку, тож обробляємо кожну один раз.
CREATE TABLE IF NOT EXISTS stripe_events (
  id          text PRIMARY KEY,
  type        text NOT NULL,
  outcome     text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
