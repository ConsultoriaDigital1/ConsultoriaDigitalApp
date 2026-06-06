require('dotenv').config();

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const rootDir = path.resolve(__dirname, '..');
const rootEnv = { ...process.env };
const databaseUrl = rootEnv.DATABASE_URL;
const localDir = path.join(rootDir, '.local');
const portablePgDir = path.join(localDir, 'postgres', 'pgsql');
const portablePgDataDir = path.join(localDir, 'postgres-data');
const portablePgLog = path.join(localDir, 'postgres.log');

if (!databaseUrl) {
  console.error('Falta DATABASE_URL en .env');
  process.exit(1);
}

let serverProcess = null;
let postgresProcess = null;

function parseDatabaseUrl() {
  try {
    const url = new URL(databaseUrl);
    return {
      host: url.hostname,
      port: url.port || '5432',
      database: url.pathname.replace(/^\//, ''),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  } catch (_err) {
    throw new Error('DATABASE_URL no tiene un formato valido.');
  }
}

function isLocalHost(host) {
  return ['localhost', '127.0.0.1', '::1'].includes(host);
}

function commandWorks(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return result.status === 0;
}

function dockerComposeCommand() {
  if (commandWorks('docker', ['compose', 'version'])) return { command: 'docker', args: ['compose'] };
  if (commandWorks('docker-compose', ['version'])) return { command: 'docker-compose', args: [] };
  return null;
}

function portablePgBin(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return path.join(portablePgDir, 'bin', exe);
}

function portablePgEnv() {
  return {
    ...rootEnv,
    PATH: `${path.join(portablePgDir, 'bin')}${path.delimiter}${rootEnv.PATH || ''}`,
  };
}

function connectionStringForDatabase(database) {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: rootEnv,
      stdio: 'inherit',
      ...options,
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${command} ${args.join(' ')} termino con codigo ${code}`));
    });
  });
}

async function canConnect() {
  return canConnectTo(databaseUrl);
}

async function canConnectTo(connectionString) {
  const pool = new Pool({
    connectionString,
    ssl: rootEnv.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  try {
    await pool.query('SELECT 1');
    return true;
  } catch (_err) {
    return false;
  } finally {
    await pool.end();
  }
}

async function waitForDatabase(timeoutMs = 30000) {
  return waitForDatabaseUrl(databaseUrl, timeoutMs);
}

async function waitForDatabaseUrl(connectionString, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await canConnectTo(connectionString)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function initPortablePostgres(db) {
  if (fs.existsSync(path.join(portablePgDataDir, 'PG_VERSION'))) return;

  fs.mkdirSync(localDir, { recursive: true });
  const pwFile = path.join(localDir, 'postgres-pw.tmp');
  fs.writeFileSync(pwFile, db.password || 'postgres', 'utf8');

  try {
    await run(portablePgBin('initdb'), [
      '-D', portablePgDataDir,
      '-U', db.user || 'postgres',
      '--pwfile', pwFile,
      '-A', 'scram-sha-256',
      '-E', 'UTF8',
    ], { env: portablePgEnv() });
  } finally {
    fs.rmSync(pwFile, { force: true });
  }

  fs.appendFileSync(
    path.join(portablePgDataDir, 'postgresql.conf'),
    [
      '',
      "listen_addresses = 'localhost'",
      `port = ${Number(db.port) || 5432}`,
    ].join('\n')
  );
}

async function createPortableAppDatabase(db) {
  const adminUrl = connectionStringForDatabase('postgres');
  const pool = new Pool({
    connectionString: adminUrl,
    ssl: rootEnv.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  try {
    const { rows } = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [db.database]);
    if (!rows[0]) {
      await pool.query(`CREATE DATABASE ${quoteIdent(db.database)}`);
    }
  } finally {
    await pool.end();
  }
}

async function ensurePortableDatabase(db) {
  if (!fs.existsSync(portablePgBin('postgres')) || process.platform !== 'win32') return false;

  await initPortablePostgres(db);

  postgresProcess = spawn(portablePgBin('postgres'), ['-D', portablePgDataDir, '-p', db.port], {
    cwd: rootDir,
    env: portablePgEnv(),
    stdio: ['ignore', fs.openSync(portablePgLog, 'a'), fs.openSync(portablePgLog, 'a')],
  });

  postgresProcess.on('exit', (code) => {
    if (!serverProcess && code) {
      console.error(`Postgres local termino con codigo ${code}. Log: ${portablePgLog}`);
    }
  });

  if (!(await waitForDatabaseUrl(connectionStringForDatabase('postgres')))) {
    throw new Error(`Postgres local no quedo disponible. Revisa ${portablePgLog}`);
  }

  await createPortableAppDatabase(db);

  if (!(await waitForDatabase())) {
    throw new Error(`Postgres local no quedo disponible. Revisa ${portablePgLog}`);
  }

  return true;
}

async function ensureLocalDatabase(db) {
  if (await canConnect()) return;

  if (await ensurePortableDatabase(db)) return;

  const compose = dockerComposeCommand();
  if (!compose) {
    throw new Error('Postgres no responde. Ejecuta npm run setup:postgres o instala Docker Desktop.');
  }

  rootEnv.POSTGRES_HOST = db.host;
  rootEnv.POSTGRES_PORT = db.port;
  rootEnv.POSTGRES_DB = db.database;
  rootEnv.POSTGRES_USER = db.user;
  rootEnv.POSTGRES_PASSWORD = db.password;

  console.log('Levantando Postgres local con Docker...');
  await run(compose.command, [...compose.args, 'up', '-d', 'postgres']);

  if (!(await waitForDatabase())) {
    throw new Error('Postgres no quedo disponible despues de levantar Docker.');
  }
}

async function main() {
  const db = parseDatabaseUrl();
  const shouldManageLocalDb = rootEnv.DEV_DB !== 'false' && isLocalHost(db.host);

  if (shouldManageLocalDb) {
    await ensureLocalDatabase(db);
    await run(process.execPath, ['db/schema.js']);
    if (rootEnv.DEV_SEED !== 'false') await run(process.execPath, ['db/seed.js']);
  }

  serverProcess = spawn(process.execPath, [
    '--watch-path=server.js',
    '--watch-path=whatsapp-service.js',
    '--watch-path=google-calendar.js',
    'server.js'
  ], {
    cwd: rootDir,
    env: rootEnv,
    stdio: 'inherit',
  });

  serverProcess.on('exit', (code) => {
    if (postgresProcess) postgresProcess.kill('SIGTERM');
    process.exit(code || 0);
  });
}

process.on('SIGINT', () => {
  if (serverProcess) serverProcess.kill('SIGINT');
  if (postgresProcess) postgresProcess.kill('SIGINT');
  if (!serverProcess) process.exit(130);
});

process.on('SIGTERM', () => {
  if (serverProcess) serverProcess.kill('SIGTERM');
  if (postgresProcess) postgresProcess.kill('SIGTERM');
  if (!serverProcess) process.exit(143);
});

main().catch((err) => {
  if (postgresProcess) postgresProcess.kill('SIGTERM');
  console.error(err.message);
  process.exit(1);
});
