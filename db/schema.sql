CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  apellido TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  equipo TEXT NOT NULL CHECK (equipo IN ('marketing', 'desarrollo', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
  cover_image TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cards_equipo ON cards(equipo);
CREATE INDEX IF NOT EXISTS idx_cards_usuario ON cards(usuario);
CREATE INDEX IF NOT EXISTS idx_cards_estado ON cards(estado);

CREATE TABLE IF NOT EXISTS team_calendars (
  equipo TEXT PRIMARY KEY CHECK (equipo IN ('marketing', 'desarrollo', 'admin')),
  google_calendar_url TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
