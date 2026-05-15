require('dotenv').config();

const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function hash(password) {
  return bcrypt.hash(password, 12);
}

async function main() {
  const users = [
    { id: 'admin-sistema', username: 'admin', nombre: 'Admin', apellido: 'Sistema', password: 'Motomipasion1', equipo: 'admin' },
    { id: 'juan-marketing', username: 'juan', nombre: 'Juan', apellido: 'Garcia', password: 'pass123', equipo: 'marketing' },
    { id: 'ana-dev', username: 'ana', nombre: 'Ana', apellido: 'Lopez', password: 'pass123', equipo: 'desarrollo' },
  ];

  for (const user of users) {
    await pool.query(
      `INSERT INTO users (id, username, nombre, apellido, password_hash, equipo)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (username) DO UPDATE SET
         password_hash = CASE WHEN users.username = 'admin' THEN EXCLUDED.password_hash ELSE users.password_hash END,
         equipo = CASE WHEN users.username = 'admin' THEN EXCLUDED.equipo ELSE users.equipo END,
         updated_at = CASE WHEN users.username = 'admin' THEN NOW() ELSE users.updated_at END`,
      [user.id, user.username, user.nombre, user.apellido, await hash(user.password), user.equipo]
    );
  }

  const now = Date.now();
  const cards = [
    { id: 'card-abc', nf: 'Empresa ABC', rs: 'ABC S.R.L.', cuit: '30-12345678-9', ca: 'ACC-001', ntel: '11-4444-5555', t: '', ta: 'Tecnologia', c: 'Primer contacto realizado.', color: 'teal', estado: 'iniciada', equipo: 'marketing', usuario: 'juan-marketing', creado_por: 'juan-marketing', creado_en: now - 864e5 * 3 },
    { id: 'card-xyz', nf: 'Comercial XYZ', rs: 'XYZ S.A.', cuit: '30-98765432-1', ca: 'ACC-002', ntel: '11-3333-4444', t: '11-9999-0000', ta: 'Comercio', c: 'Propuesta enviada.', color: 'purple', estado: 'en_proceso', equipo: 'desarrollo', usuario: 'ana-dev', creado_por: 'ana-dev', creado_en: now - 864e5 * 2 },
    { id: 'card-def', nf: 'Servicios DEF', rs: 'DEF & Asoc.', cuit: '20-55555555-5', ca: 'ACC-003', ntel: '11-2222-3333', t: '11-5555-6666', ta: 'Servicios profesionales', c: 'Facturacion pendiente.', color: 'green', estado: 'finalizado', equipo: 'admin', usuario: 'admin-sistema', creado_por: 'admin-sistema', creado_en: now - 864e5, debe: 'si', monto_deuda: '85000', vence: new Date(now + 864e5 * 5).toISOString().slice(0, 10) },
  ];

  for (const card of cards) {
    await pool.query(
      `INSERT INTO cards (
        id, nf, rs, cuit, ca, ntel, t, ta, c, color, estado, equipo, usuario,
        creado_por, creado_en, debe, monto_deuda, vence
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (id) DO NOTHING`,
      [
        card.id, card.nf, card.rs, card.cuit, card.ca, card.ntel, card.t, card.ta, card.c,
        card.color, card.estado, card.equipo, card.usuario, card.creado_por, card.creado_en,
        card.debe || 'no', card.monto_deuda || '', card.vence || '',
      ]
    );

    if (card.c) {
      await pool.query(
        `INSERT INTO card_description_history (id, card_id, user_id, description, creado_en, created_at)
         SELECT $1, $2, $3, $4, $5::bigint, to_timestamp($5::double precision / 1000.0)
         WHERE NOT EXISTS (
           SELECT 1 FROM card_description_history WHERE card_id = $2
         )
         ON CONFLICT (id) DO NOTHING`,
        ['initial-' + card.id, card.id, card.creado_por, card.c, card.creado_en]
      );
    }
  }

  console.log('Seed listo. Usuarios: admin/Motomipasion1, juan/pass123, ana/pass123');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
