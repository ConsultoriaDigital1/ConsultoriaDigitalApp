require('dotenv').config();

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

function mkId() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function usage(msg) {
  if (msg) console.error('Error: ' + msg + '\n');
  console.error('Uso: node db/create-admin.js <username> <password> [nombre] [apellido]');
  console.error('Ej:  node db/create-admin.js nicolas MiClave123 Nicolas Mendez');
  process.exit(1);
}

async function main() {
  const [, , rawUsername, password, nombreArg, apellidoArg] = process.argv;

  const username = String(rawUsername || '').trim().toLowerCase();
  const nombre = String(nombreArg || rawUsername || '').trim();
  const apellido = String(apellidoArg || '').trim();

  if (!username || !password) usage('Faltan username y/o password.');
  if (password.length < 6) usage('La contrasena debe tener al menos 6 caracteres.');

  const passwordHash = await bcrypt.hash(password, 12);

  // Crea el admin; si el username ya existe, lo promueve a admin y resetea la contrasena.
  const { rows } = await pool.query(
    `INSERT INTO users (id, username, nombre, apellido, password_hash, equipo)
     VALUES ($1, $2, $3, $4, $5, 'admin')
     ON CONFLICT (username) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       equipo = 'admin',
       updated_at = NOW()
     RETURNING id, username, nombre, apellido, equipo, (xmax = 0) AS inserted`,
    [mkId(), username, nombre, apellido, passwordHash]
  );

  const u = rows[0];
  console.log(`${u.inserted ? 'Admin creado' : 'Usuario existente promovido a admin (contrasena actualizada)'}: ${u.username} (equipo=${u.equipo})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
