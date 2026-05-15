CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  apellido TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  equipo TEXT NOT NULL CHECK (equipo IN ('marketing', 'desarrollo', 'admin')),
  avatar_image TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_image TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  nf TEXT NOT NULL DEFAULT '',
  rs TEXT NOT NULL DEFAULT '',
  cuit TEXT NOT NULL DEFAULT '',
  ca TEXT NOT NULL DEFAULT '',
  ntel TEXT NOT NULL DEFAULT '',
  t TEXT NOT NULL DEFAULT '',
  ta TEXT NOT NULL DEFAULT '',
  c TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'none',
  estado TEXT NOT NULL CHECK (estado IN ('iniciada', 'en_proceso', 'finalizado')),
  equipo TEXT NOT NULL CHECK (equipo IN ('marketing', 'desarrollo', 'admin')),
  usuario TEXT REFERENCES users(id) ON DELETE SET NULL,
  creado_por TEXT REFERENCES users(id) ON DELETE SET NULL,
  creado_en BIGINT NOT NULL,
  debe TEXT NOT NULL DEFAULT 'no',
  monto_deuda TEXT NOT NULL DEFAULT '',
  vence TEXT NOT NULL DEFAULT '',
  vence_hora TEXT NOT NULL DEFAULT '',
  cover_image TEXT NOT NULL DEFAULT '',
  checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE cards ADD COLUMN IF NOT EXISTS checklist JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS vence_hora TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_cards_equipo ON cards(equipo);
CREATE INDEX IF NOT EXISTS idx_cards_usuario ON cards(usuario);
CREATE INDEX IF NOT EXISTS idx_cards_estado ON cards(estado);

CREATE TABLE IF NOT EXISTS card_description_history (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  creado_en BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_card_description_history_card
  ON card_description_history(card_id, creado_en DESC);

INSERT INTO card_description_history (id, card_id, user_id, description, creado_en, created_at)
SELECT 'initial-' || ca.id, ca.id, ca.creado_por, ca.c, ca.creado_en, to_timestamp(ca.creado_en / 1000.0)
FROM cards ca
WHERE ca.c <> ''
  AND NOT EXISTS (
    SELECT 1 FROM card_description_history h WHERE h.card_id = ca.id
  )
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS team_calendars (
  equipo TEXT PRIMARY KEY CHECK (equipo IN ('marketing', 'desarrollo', 'admin')),
  google_calendar_url TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
