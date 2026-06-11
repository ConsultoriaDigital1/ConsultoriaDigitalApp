require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcrypt');
const express = require('express');
const { Pool } = require('pg');
const EventEmitter = require('events');
const gcal = require('./google-calendar');

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});
const cardEvents = new EventEmitter();

const PORT = Number(process.env.PORT || 3000);
const COOKIE_NAME = 'cd_session';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-change-me';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const GOOGLE_CALENDAR_CTZ = process.env.GOOGLE_CALENDAR_CTZ || 'America/Argentina/Buenos_Aires';

if (process.env.NODE_ENV === 'production' && SESSION_SECRET === 'dev-only-change-me') {
  throw new Error('Defini SESSION_SECRET en produccion.');
}

async function ensureDatabaseMigrations() {
  await pool.query("ALTER TABLE cards ADD COLUMN IF NOT EXISTS whatsapp_lid_alias TEXT NOT NULL DEFAULT ''");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_cards_whatsapp_lid_alias ON cards(whatsapp_lid_alias)");
  await pool.query("ALTER TABLE cards ADD COLUMN IF NOT EXISTS pauta_url TEXT NOT NULL DEFAULT ''");
  await pool.query("ALTER TABLE cards ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb");
  await pool.query("ALTER TABLE client_movements ADD COLUMN IF NOT EXISTS archivos JSONB NOT NULL DEFAULT '[]'::jsonb");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_notes (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'team', 'admin')),
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      equipo TEXT CHECK (equipo IN ('marketing', 'desarrollo', 'admin')),
      content TEXT NOT NULL DEFAULT '',
      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_app_notes_personal ON app_notes(user_id) WHERE scope = 'personal'");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_app_notes_team ON app_notes(equipo) WHERE scope = 'team'");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_app_notes_admin ON app_notes(scope) WHERE scope = 'admin'");

  // Ventas Check Constraints
  await pool.query("ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_equipo_check");
  await pool.query("ALTER TABLE cards ADD CONSTRAINT cards_equipo_check CHECK (equipo IN ('marketing', 'desarrollo', 'admin', 'ventas'))");
  await pool.query("ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_estado_check");
  await pool.query("ALTER TABLE cards ADD CONSTRAINT cards_estado_check CHECK (estado IN ('iniciada', 'en_proceso', 'finalizado', 'contactado', 'presupuestado', 'reunion', 'venta_exitosa', 'papelera'))");

  // Migrate old sales cards in 'papelera' column status to actual soft-deleted cards
  await pool.query("UPDATE cards SET deleted_at = NOW(), estado = 'presupuestado', updated_at = NOW() WHERE equipo = 'ventas' AND estado = 'papelera' AND deleted_at IS NULL");

  // WhatsApp Messages Table and Index
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      sender_jid TEXT NOT NULL,
      receiver_jid TEXT NOT NULL,
      body TEXT NOT NULL,
      timestamp BIGINT NOT NULL,
      from_me BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_chat_jid ON whatsapp_messages(chat_jid, timestamp)");

  // Crear usuario system-bot si no existe
  await pool.query(`
    INSERT INTO users (id, username, nombre, apellido, password_hash, equipo)
    VALUES ('system-bot', 'bot', 'Bot', 'n8n', 'NO_LOGIN', 'admin')
    ON CONFLICT (username) DO NOTHING
  `);
}

app.use(express.json({ limit: '100mb' }));

function mkId() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return ['', ''];
      return [part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim())];
    }).filter(([key]) => key)
  );
}

function signSession(userId) {
  const body = Buffer.from(JSON.stringify({ userId, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySession(token) {
  try {
    if (!token || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload.userId : null;
  } catch (_err) {
    return null;
  }
}

function setSessionCookie(res, userId) {
  const secure = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
  res.cookie(COOKIE_NAME, signSession(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function userDTO(row) {
  return {
    id: row.id,
    username: row.username,
    nombre: row.nombre,
    apellido: row.apellido,
    equipo: row.equipo,
    avatarImage: row.avatar_image || '',
    autosaveCards: row.autosave_cards === true,
  };
}

function cardDTO(row, descriptionHistory = []) {
  const usuarios = cardAssignedIds(row);
  return {
    id: row.id,
    nf: row.nf,
    rs: row.rs,
    cuit: row.cuit,
    ca: row.ca,
    ntel: row.ntel,
    t: row.t,
    ta: row.ta,
    c: row.c,
    color: row.color,
    estado: row.estado,
    equipo: row.equipo,
    whatsappLidAlias: row.whatsapp_lid_alias || '',
    usuario: row.usuario || usuarios[0] || null,
    usuarios,
    creadoPor: row.creado_por,
    creadoEn: Number(row.creado_en),
    debe: row.debe,
    montoDeuda: row.monto_deuda,
    vence: row.vence,
    venceHora: row.vence_hora || '',
    coverImage: row.cover_image,
    pautaUrl: row.pauta_url || '',
    checklist: cleanChecklist(row.checklist),
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    dailyCheckDate: row.daily_check_date || '',
    position: row.position == null ? null : Number(row.position),
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
    descriptionHistory,
  };
}

function descriptionHistoryDTO(row) {
  return {
    id: row.id,
    cardId: row.card_id,
    userId: row.user_id,
    description: row.description,
    kind: row.kind || 'descripcion',
    creadoEn: Number(row.creado_en),
  };
}

async function descriptionHistoryByCardIds(cardIds, db = pool) {
  const ids = [...new Set(cardIds.filter(Boolean))];
  const historyByCard = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return historyByCard;

  const { rows } = await db.query(
    `SELECT id, card_id, user_id, description, kind, creado_en
     FROM card_description_history
     WHERE card_id = ANY($1)
     ORDER BY creado_en DESC, created_at DESC`,
    [ids]
  );

  for (const row of rows) {
    if (!historyByCard.has(row.card_id)) historyByCard.set(row.card_id, []);
    historyByCard.get(row.card_id).push(descriptionHistoryDTO(row));
  }
  return historyByCard;
}

async function insertDescriptionHistory(db, cardId, userId, description, creadoEn = Date.now(), kind = 'descripcion') {
  const { rows } = await db.query(
    `INSERT INTO card_description_history (id, card_id, user_id, description, kind, creado_en)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, card_id, user_id, description, kind, creado_en`,
    [mkId(), cardId, userId, String(description || ''), kind, creadoEn]
  );
  return descriptionHistoryDTO(rows[0]);
}

function fmtVenceForActivity(vence, venceHora) {
  const v = String(vence || '').trim();
  if (!v) return '';
  const h = String(venceHora || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [yyyy, mm, dd] = v.split('-');
    return `${dd}/${mm}/${yyyy}${h ? ' ' + h : ''}`;
  }
  return h ? `${v} ${h}` : v;
}

function isAdmin(user) {
  return user && user.equipo === 'admin';
}

function allowedTeams(user) {
  return isAdmin(user) ? ['marketing', 'desarrollo', 'admin', 'ventas'] : [user.equipo];
}

function canAccessTeam(user, team) {
  return allowedTeams(user).includes(team);
}

async function getUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

function requireExternalAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const expectedKey = process.env.EXTERNAL_API_KEY;

  if (!expectedKey) {
    console.error('[External Auth] EXTERNAL_API_KEY is not configured in environment.');
    return res.status(500).json({ error: 'Configuración externa no inicializada.' });
  }

  if (!apiKey || apiKey !== expectedKey) {
    return res.status(401).json({ error: 'No autorizado. API Key inválida o ausente.' });
  }

  next();
}

async function requireAuth(req, res, next) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const userId = verifySession(cookies[COOKIE_NAME]);
    const user = userId ? await getUserById(userId) : null;
    if (!user) return res.status(401).json({ error: 'Sesion requerida.' });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (!req.user || req.user.equipo !== 'admin') {
      return res.status(403).json({ error: 'Solo administradores.' });
    }
    next();
  });
}

// ── DTOs y helpers para clients/movements ──
function clientDTO(row, balance = null) {
  const saldo = balance != null ? Number(balance.saldo || 0) : 0;
  return {
    id: row.id,
    nombreFantasia: row.nombre_fantasia || '',
    razonSocial: row.razon_social || '',
    cuit: row.cuit || '',
    direccion: row.direccion || '',
    telAdmin: row.tel_admin || '',
    telDueno: row.tel_dueno || '',
    mail1: row.mail1 || '',
    mail2: row.mail2 || '',
    vence: row.vence || '',
    estadoCliente: row.estado_cliente || 'activo',
    descripcion: row.descripcion || '',
    cardId: row.card_id || null,
    creadoPor: row.creado_por || null,
    creadoEn: Number(row.creado_en) || 0,
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
    saldo,
  };
}

function movementDTO(row, saldoAcumulado = null) {
  return {
    id: row.id,
    clientId: row.client_id,
    fecha: row.fecha || '',
    medioPago: row.medio_pago || '',
    banco: row.banco || '',
    detalle: row.detalle || '',
    montoFactura: Number(row.monto_factura || 0),
    debe: Number(row.debe || 0),
    haber: Number(row.haber || 0),
    creadoPor: row.creado_por || null,
    creadoEn: Number(row.creado_en) || 0,
    saldoAcumulado: saldoAcumulado != null ? Number(saldoAcumulado) : null,
    archivos: Array.isArray(row.archivos) ? row.archivos : [],
  };
}

function cleanArchivosMovement(value) {
  let items = value;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch (_e) { items = []; }
  }
  if (!Array.isArray(items)) return [];
  return items.slice(0, 10).map((item) => {
    if (!item || typeof item !== 'object') return null;
    const id = String(item.id || '').slice(0, 80);
    const name = String(item.name || '').slice(0, 255);
    const type = String(item.type || '').slice(0, 100);
    const size = Number(item.size) || 0;
    const data = String(item.data || '');
    if (!id || !name || !data) return null;
    // Max ~8 MB en base64
    if (data.length > 11_000_000) return null;
    if (!/^data:(application\/pdf|image\/(png|jpeg|webp));base64,[A-Za-z0-9+/=]+$/.test(data)) return null;
    return { id, name, type, size };
  }).filter(Boolean);
}

function cleanArchivosMovementWithData(value) {
  let items = value;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch (_e) { items = []; }
  }
  if (!Array.isArray(items)) return [];
  return items.slice(0, 10).map((item) => {
    if (!item || typeof item !== 'object') return null;
    const id = String(item.id || '').slice(0, 80);
    const name = String(item.name || '').slice(0, 255);
    const type = String(item.type || '').slice(0, 100);
    const size = Number(item.size) || 0;
    const data = String(item.data || '');
    if (!id || !name || !data) return null;
    if (data.length > 11_000_000) return null;
    if (!/^data:(application\/pdf|image\/(png|jpeg|webp));base64,[A-Za-z0-9+/=]+$/.test(data)) return null;
    return { id, name, type, size, data };
  }).filter(Boolean);
}

function noteDTO(row) {
  return {
    id: row.id,
    scope: row.scope,
    userId: row.user_id || null,
    equipo: row.equipo || '',
    content: row.content || '',
    updatedBy: row.updated_by || null,
    updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
  };
}

function groupNotes(rows, user) {
  const notes = { personal: null, teams: {} };
  for (const row of rows) {
    const note = noteDTO(row);
    if (note.scope === 'personal') notes.personal = note;
    if (note.scope === 'team' && note.equipo) notes.teams[note.equipo] = note;
    if (note.scope === 'admin' && isAdmin(user)) notes.admin = note;
  }
  return notes;
}

async function visibleNotes(user) {
  const teams = allowedTeams(user);
  const { rows } = await pool.query(
    `SELECT * FROM app_notes
     WHERE (scope = 'personal' AND user_id = $1)
        OR (scope = 'team' AND equipo = ANY($2))
        OR (scope = 'admin' AND $3 = TRUE)
     ORDER BY scope, equipo NULLS LAST`,
    [user.id, teams, isAdmin(user)]
  );
  return groupNotes(rows, user);
}

async function clientBalances() {
  // Saldo = total facturado - total pagado (haber)
  const { rows } = await pool.query(
    `SELECT client_id, COALESCE(SUM(monto_factura),0) - COALESCE(SUM(haber),0) AS saldo
     FROM client_movements
     GROUP BY client_id`
  );
  const map = {};
  rows.forEach((r) => { map[r.client_id] = { saldo: Number(r.saldo) }; });
  return map;
}

async function listClients(includeDeleted = false) {
  const where = includeDeleted ? '' : 'WHERE deleted_at IS NULL';
  const { rows } = await pool.query(
    `SELECT * FROM clients ${where} ORDER BY LOWER(nombre_fantasia), LOWER(razon_social)`
  );
  const balances = await clientBalances();
  return rows.map((r) => clientDTO(r, balances[r.id] || { saldo: 0 }));
}

async function listTrashedClients() {
  const { rows } = await pool.query(
    `SELECT * FROM clients WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`
  );
  const balances = await clientBalances();
  return rows.map((r) => clientDTO(r, balances[r.id] || { saldo: 0 }));
}

async function getClientById(id) {
  const { rows } = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
  return rows[0] || null;
}

const ALLOWED_MEDIO_PAGO = new Set(['efectivo', 'transferencia', 'cheque', 'echeque', 'tarjeta', 'canje', '']);

function cleanMoney(value) {
  if (value == null || value === '') return 0;
  const num = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.round(num * 100) / 100;
}

function cleanDate(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  return s;
}

async function visibleUsers(user) {
  const teams = allowedTeams(user);
  const { rows } = await pool.query(
    'SELECT id, username, nombre, apellido, equipo, avatar_image FROM users WHERE equipo = ANY($1) ORDER BY nombre, apellido',
    [teams]
  );
  return rows.map(userDTO);
}

async function visibleCards(user) {
  const teams = allowedTeams(user);
  const { rows } = await pool.query(
    `SELECT * FROM cards
     WHERE equipo = ANY($1) AND deleted_at IS NULL
     ORDER BY position ASC NULLS LAST, creado_en DESC`,
    [teams]
  );
  const historyByCard = await descriptionHistoryByCardIds(rows.map((row) => row.id));
  return rows.map((row) => cardDTO(row, historyByCard.get(row.id) || []));
}

async function trashedCards(user) {
  const teams = allowedTeams(user);
  const { rows } = await pool.query(
    `SELECT * FROM cards
     WHERE equipo = ANY($1) AND deleted_at IS NOT NULL
     ORDER BY deleted_at DESC`,
    [teams]
  );
  const historyByCard = await descriptionHistoryByCardIds(rows.map((row) => row.id));
  return rows.map((row) => cardDTO(row, historyByCard.get(row.id) || []));
}

async function visibleCalendars(user) {
  const teams = allowedTeams(user);
  const { rows } = await pool.query(
    'SELECT equipo, google_calendar_url FROM team_calendars WHERE equipo = ANY($1)',
    [teams]
  );
  const fromDb = Object.fromEntries(rows.map((r) => [r.equipo, r.google_calendar_url || '']));
  return Object.fromEntries(teams.map((team) => [team, fromDb[team] || calendarUrlFromEnv(team)]));
}

// Mapa { equipo: bool } indicando si el calendario del equipo es editable (hay
// service account configurada Y se pudo derivar el ID del calendario).
function calendarsEditableMap(calendars) {
  const configured = gcal.isConfigured();
  return Object.fromEntries(
    Object.entries(calendars).map(([team, url]) => [team, configured && !!calendarIdFromUrl(url)])
  );
}

// Extrae el ID del calendario (parametro ?src=...) de una URL de embed de Google.
function calendarIdFromUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return (parsed.searchParams.get('src') || '').trim();
  } catch (_e) {
    return '';
  }
}

// Resuelve el calendarId del equipo (DB primero, luego variables de entorno).
async function resolveTeamCalendarId(team) {
  const { rows } = await pool.query(
    'SELECT google_calendar_url FROM team_calendars WHERE equipo = $1',
    [team]
  );
  const url = (rows[0] && rows[0].google_calendar_url) || calendarUrlFromEnv(team);
  return calendarIdFromUrl(url);
}

async function visibleEvents(user) {
  const teams = allowedTeams(user);
  const { rows } = await pool.query(
    'SELECT * FROM calendar_events WHERE equipo = ANY($1) ORDER BY fecha, hora_inicio',
    [teams]
  );
  return rows.map(r => ({
    id: r.id, titulo: r.titulo, descripcion: r.descripcion,
    fecha: r.fecha, horaInicio: r.hora_inicio, horaFin: r.hora_fin,
    equipo: r.equipo, color: r.color, creadoPor: r.creado_por, creadoEn: r.creado_en,
  }));
}

function cleanUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function cleanTeam(value) {
  return ['marketing', 'desarrollo', 'admin', 'ventas'].includes(value) ? value : '';
}

function cleanUserIds(value) {
  let ids = value;
  if (typeof ids === 'string') {
    const trimmed = ids.trim();
    if (trimmed.startsWith('[')) {
      try {
        ids = JSON.parse(trimmed);
      } catch (_err) {
        ids = [];
      }
    } else {
      ids = trimmed ? [trimmed] : [];
    }
  }
  if (!Array.isArray(ids)) ids = ids ? [ids] : [];
  const seen = new Set();
  return ids
    .map((id) => String(id || '').trim().slice(0, 80))
    .filter((id) => id && !seen.has(id) && seen.add(id))
    .slice(0, 20);
}

function cardAssignedIds(row = {}) {
  const ids = cleanUserIds(row.usuarios);
  if (row.usuario && !ids.includes(row.usuario)) ids.unshift(row.usuario);
  return ids;
}

function cleanChecklist(value) {
  let items = value;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch (_err) {
      items = [];
    }
  }
  if (!Array.isArray(items)) return [];
  return items.slice(0, 100).map((item) => {
    const text = String(item && item.text != null ? item.text : '').trim().slice(0, 500);
    if (!text) return null;
    const id = String(item && item.id ? item.id : '').trim().slice(0, 80) || mkId();
    const usuario = cleanUserIds(item && item.usuario)[0] || null;
    const done = item && item.done === true;
    return { id, text, done, progress: !done && item && item.progress === true, usuario };
  }).filter(Boolean);
}

function cleanAttachments(value) {
  let items = value;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch (_e) { items = []; }
  }
  if (!Array.isArray(items)) return [];
  return items.slice(0, 50).map((item) => {
    if (!item || typeof item !== 'object') return null;
    const id = String(item.id || '').slice(0, 80);
    const name = String(item.name || '').slice(0, 255);
    const type = String(item.type || '').slice(0, 100);
    const size = Number(item.size) || 0;
    const data = String(item.data || '');
    const uploadedAt = Number(item.uploadedAt) || 0;
    const uploadedBy = item.uploadedBy ? String(item.uploadedBy).slice(0, 80) : null;
    if (!id || !name || !data) return null;
    return { id, name, type, size, data, uploadedAt, uploadedBy };
  }).filter(Boolean);
}

function calendarUrlFromEnv(team) {
  const key = team.toUpperCase();
  const value = String(process.env[`GOOGLE_CALENDAR_${key}_ID`] || process.env[`GOOGLE_CALENDAR_${key}`] || '').trim();
  if (!value) return '';
  if (value.startsWith('https://')) return cleanCalendarUrl(value);
  return 'https://calendar.google.com/calendar/embed?src=' + encodeURIComponent(value) + '&ctz=' + encodeURIComponent(GOOGLE_CALENDAR_CTZ);
}

function cleanCalendarUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (url.length > 2048) {
    const err = new Error('El calendario es demasiado largo.');
    err.status = 400;
    throw err;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'calendar.google.com' || !parsed.pathname.includes('/calendar/embed')) {
      throw new Error();
    }
  } catch (_err) {
    const err = new Error('Google Calendar invalido.');
    err.status = 400;
    throw err;
  }
  return url;
}

function cleanAvatarImage(value) {
  const image = String(value || '').trim();
  if (!image) return '';
  if (image.length > 850000) {
    const err = new Error('La imagen de perfil es demasiado grande.');
    err.status = 400;
    throw err;
  }
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) {
    const err = new Error('La imagen de perfil debe ser PNG, JPG o WebP.');
    err.status = 400;
    throw err;
  }
  return image;
}

function cardValues(body, user, existing = {}) {
  const equipo = cleanTeam(body.equipo || existing.equipo || user.equipo);
  const rawVenceHora = String(body.venceHora ?? existing.vence_hora ?? '');
  const existingUsuarios = cardAssignedIds(existing);
  const hasUsuarios = Object.prototype.hasOwnProperty.call(body, 'usuarios');
  const hasUsuario = Object.prototype.hasOwnProperty.call(body, 'usuario');
  const usuarios = hasUsuarios
    ? cleanUserIds(body.usuarios)
    : (hasUsuario ? cleanUserIds(body.usuario) : existingUsuarios);
  if (!equipo || !canAccessTeam(user, equipo)) {
    const err = new Error('No tenes permiso para ese equipo.');
    err.status = 403;
    throw err;
  }
  return {
    nf: String(body.nf || ''),
    rs: String(body.rs || ''),
    cuit: String(body.cuit || ''),
    ca: String(body.ca || ''),
    ntel: String(body.ntel || ''),
    t: String(body.t || ''),
    ta: String(body.ta || ''),
    c: String(body.c || ''),
    color: String(body.color || 'none'),
    estado: (() => {
      const isVentas = (equipo === 'ventas');
      const validStatuses = isVentas
        ? ['contactado', 'presupuestado', 'reunion', 'venta_exitosa', 'papelera']
        : ['iniciada', 'en_proceso', 'finalizado'];
      const defaultStatus = isVentas ? 'contactado' : 'iniciada';
      return validStatuses.includes(body.estado) ? body.estado : defaultStatus;
    })(),
    equipo,
    usuario: usuarios[0] || null,
    usuarios,
    debe: body.debe === 'si' ? 'si' : 'no',
    montoDeuda: String(body.montoDeuda || ''),
    vence: String(body.vence || ''),
    venceHora: /^\d{2}:\d{2}$/.test(rawVenceHora) ? rawVenceHora : '',
    coverImage: String(body.coverImage || ''),
    pautaUrl: Object.prototype.hasOwnProperty.call(body, 'pautaUrl')
      ? String(body.pautaUrl || '')
      : String(existing.pauta_url || ''),
    checklist: cleanChecklist(body.checklist ?? existing.checklist ?? []),
    attachments: cleanAttachments(body.attachments ?? existing.attachments ?? []),
  };
}

async function validateAssignedUsers(user, assignedIds, team) {
  const ids = cleanUserIds(assignedIds);
  if (!ids.length) return [];
  const { rows } = await pool.query('SELECT id, equipo FROM users WHERE id = ANY($1)', [ids]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) {
    const assigned = byId.get(id);
    if (!assigned) {
      const err = new Error('Usuario asignado invalido.');
      err.status = 400;
      throw err;
    }
    if (!canAccessTeam(user, assigned.equipo) || assigned.equipo !== team) {
      const err = new Error('El usuario asignado no pertenece a ese equipo.');
      err.status = 403;
      throw err;
    }
  }
  return ids;
}

async function validateChecklistUsers(user, checklist, team) {
  const ids = cleanUserIds(checklist.map((item) => item.usuario).filter(Boolean));
  const validIds = new Set(await validateAssignedUsers(user, ids, team));
  return checklist.map((item) => ({
    ...item,
    usuario: item.usuario && validIds.has(item.usuario) ? item.usuario : null,
  }));
}

function validateCardRequired(data) {
  if (!data.nf.trim() && !data.rs.trim()) {
    const err = new Error('Ingresa al menos el Nombre Fiscal o Razon Social.');
    err.status = 400;
    throw err;
  }
}

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const username = cleanUsername(req.body.username);
    const password = String(req.body.password || '');

    // Bypass local para desarrollo: si las credenciales coinciden con las vars de entorno, busca el usuario admin en la DB
    if (
      process.env.NODE_ENV === 'development' &&
      process.env.DEV_BYPASS_USER &&
      process.env.DEV_BYPASS_PASSWORD &&
      username === process.env.DEV_BYPASS_USER &&
      password === process.env.DEV_BYPASS_PASSWORD
    ) {
      const { rows: devRows } = await pool.query('SELECT * FROM users WHERE equipo = $1 LIMIT 1', ['admin']);
      const devUser = devRows[0];
      if (devUser) {
        setSessionCookie(res, devUser.id);
        return res.json({ user: userDTO(devUser) });
      }
    }

    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Usuario o contrasena incorrectos.' });
    }
    setSessionCookie(res, user.id);
    res.json({ user: userDTO(user) });
  } catch (err) {
    next(err);
  }
});


app.post('/api/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/bootstrap', requireAuth, async (req, res, next) => {
  try {
    const isAdmin = req.user.equipo === 'admin';
    const calendars = await visibleCalendars(req.user);
    res.json({
      user: userDTO(req.user),
      users: await visibleUsers(req.user),
      cards: await visibleCards(req.user),
      cardsTrash: await trashedCards(req.user),
      calendars,
      calendarsEditable: calendarsEditableMap(calendars),
      events: await visibleEvents(req.user),
      notes: await visibleNotes(req.user),
      teams: allowedTeams(req.user),
      clients: isAdmin ? await listClients() : [],
      clientsTrash: isAdmin ? await listTrashedClients() : [],
      libretaUrl: isAdmin ? (process.env.LIBRETA_URL || '') : '',
      flujoFondosUrl: isAdmin ? (process.env.FLUJO_FONDOS_URL || '') : '',
    });
  } catch (err) {
    next(err);
  }
});

// ════════════════════════════════════════════
// INTEGRACION WHATSAPP
// ════════════════════════════════════════════
const whatsappService = require('./whatsapp-service');

app.get('/api/whatsapp/status', requireAuth, (req, res) => {
  res.json({
    status: whatsappService.getStatus(),
    qrCode: whatsappService.getQrCode()
  });
});

app.get('/api/whatsapp/chats/:phone/messages', requireAuth, async (req, res, next) => {
  try {
    const cleaned = whatsappService.cleanPhoneForWhatsapp(req.params.phone);
    const candidateJids = new Set();
    if (cleaned) {
      candidateJids.add(cleaned + '@s.whatsapp.net');
      candidateJids.add(cleaned + '@lid');
    }
    try {
      const resolved = await whatsappService.resolvePhoneLid(req.params.phone);
      if (resolved) {
        candidateJids.add(resolved);
      }
    } catch (e) {
      // ignore
    }

    const { rows: dbMessages } = await pool.query(
      `SELECT id, sender_jid AS "from", receiver_jid AS "to", body, timestamp, from_me AS "fromMe"
       FROM whatsapp_messages
       WHERE chat_jid = ANY($1)
       ORDER BY timestamp ASC`,
      [[...candidateJids]]
    );

    let memoryMessages = [];
    try {
      memoryMessages = await whatsappService.getChatHistory(req.params.phone);
    } catch (memErr) {
      console.log('[WhatsApp History] Falling back to DB-only because service is disconnected:', memErr.message);
    }

    const mergedMap = new Map();
    for (const msg of dbMessages) {
      mergedMap.set(msg.id, {
        id: msg.id,
        from: msg.from,
        to: msg.to,
        body: msg.body,
        timestamp: Number(msg.timestamp),
        fromMe: msg.fromMe
      });
    }
    for (const msg of memoryMessages) {
      mergedMap.set(msg.id, msg);
    }

    const messages = [...mergedMap.values()].sort((a, b) => a.timestamp - b.timestamp);
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error al obtener mensajes.' });
  }
});

app.post('/api/whatsapp/chats/:phone/messages', requireAuth, async (req, res, next) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'El mensaje no puede estar vacío.' });
    }
    const sent = await whatsappService.sendMessage(req.params.phone, message);
    res.json({ ok: true, message: sent });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error al enviar mensaje.' });
  }
});

app.post('/api/whatsapp/logout', requireAuth, async (req, res, next) => {
  try {
    await whatsappService.logout();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error al desconectar WhatsApp.' });
  }
});

app.get('/api/whatsapp/sse', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current status immediately
  res.write(`event: status\ndata: ${JSON.stringify({ status: whatsappService.getStatus(), qrCode: whatsappService.getQrCode() })}\n\n`);

  const onStatusChange = (statusData) => {
    res.write(`event: status\ndata: ${JSON.stringify(statusData)}\n\n`);
  };

  const onMessage = (msg) => {
    res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
  };

  const onCardChange = (change) => {
    res.write(`event: card_change\ndata: ${JSON.stringify(change)}\n\n`);
  };

  whatsappService.events.on('status', onStatusChange);
  whatsappService.events.on('message', onMessage);
  cardEvents.on('change', onCardChange);

  req.on('close', () => {
    whatsappService.events.off('status', onStatusChange);
    whatsappService.events.off('message', onMessage);
    cardEvents.off('change', onCardChange);
  });
});

// ════════════════════════════════════════════
// NOTAS
// ════════════════════════════════════════════
app.get('/api/notes', requireAuth, async (req, res, next) => {
  try {
    res.json({ notes: await visibleNotes(req.user) });
  } catch (err) {
    next(err);
  }
});

app.put('/api/notes/:scope', requireAuth, async (req, res, next) => {
  try {
    const scope = String(req.params.scope || '');
    if (!['personal', 'team', 'admin'].includes(scope)) {
      return res.status(400).json({ error: 'Tipo de nota invalido.' });
    }
    if (scope === 'admin' && !isAdmin(req.user)) {
      return res.status(403).json({ error: 'Solo administradores.' });
    }

    const body = req.body || {};
    const content = String(body.content || '').slice(0, 50000);
    const equipo = scope === 'team' ? (cleanTeam(body.equipo) || req.user.equipo) : null;
    if (scope === 'team' && !canAccessTeam(req.user, equipo)) {
      return res.status(403).json({ error: 'Sin acceso a ese equipo.' });
    }

    let rows;
    if (scope === 'personal') {
      ({ rows } = await pool.query(
        `INSERT INTO app_notes (id, scope, user_id, content, updated_by)
         VALUES ($1, 'personal', $2, $3, $4)
         ON CONFLICT (user_id) WHERE scope = 'personal'
         DO UPDATE SET content = EXCLUDED.content, updated_by = EXCLUDED.updated_by, updated_at = NOW()
         RETURNING *`,
        [mkId(), req.user.id, content, req.user.id]
      ));
    } else if (scope === 'team') {
      ({ rows } = await pool.query(
        `INSERT INTO app_notes (id, scope, equipo, content, updated_by)
         VALUES ($1, 'team', $2, $3, $4)
         ON CONFLICT (equipo) WHERE scope = 'team'
         DO UPDATE SET content = EXCLUDED.content, updated_by = EXCLUDED.updated_by, updated_at = NOW()
         RETURNING *`,
        [mkId(), equipo, content, req.user.id]
      ));
    } else {
      ({ rows } = await pool.query(
        `INSERT INTO app_notes (id, scope, content, updated_by)
         VALUES ($1, 'admin', $2, $3)
         ON CONFLICT (scope) WHERE scope = 'admin'
         DO UPDATE SET content = EXCLUDED.content, updated_by = EXCLUDED.updated_by, updated_at = NOW()
         RETURNING *`,
        [mkId(), content, req.user.id]
      ));
    }
    res.json({ note: noteDTO(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// ════════════════════════════════════════════
// ADMIN — CLIENTES
// ════════════════════════════════════════════
app.get('/api/admin/clients', requireAdmin, async (_req, res, next) => {
  try {
    res.json({ clients: await listClients() });
  } catch (err) { next(err); }
});

app.get('/api/admin/clients/trash', requireAdmin, async (_req, res, next) => {
  try {
    res.json({ clients: await listTrashedClients() });
  } catch (err) { next(err); }
});

app.post('/api/admin/clients', requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const nombre = String(b.nombreFantasia || '').trim();
    if (!nombre) return res.status(400).json({ error: 'El nombre de fantasia es obligatorio.' });

    const estadoCliente = ['activo', 'inactivo'].includes(b.estadoCliente) ? b.estadoCliente : 'activo';
    const id = mkId();
    const creadoEn = Date.now();
    const { rows } = await pool.query(
      `INSERT INTO clients (
         id, nombre_fantasia, razon_social, cuit, direccion,
         tel_admin, tel_dueno, mail1, mail2, vence,
         estado_cliente, descripcion,
         creado_por, creado_en
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        id,
        nombre,
        String(b.razonSocial || '').trim(),
        String(b.cuit || '').trim(),
        String(b.direccion || '').trim(),
        String(b.telAdmin || '').trim(),
        String(b.telDueno || '').trim(),
        String(b.mail1 || '').trim(),
        String(b.mail2 || '').trim(),
        cleanDate(b.vence),
        estadoCliente,
        String(b.descripcion || '').trim(),
        req.user.id,
        creadoEn,
      ]
    );
    res.status(201).json({ client: clientDTO(rows[0], { saldo: 0 }) });
  } catch (err) { next(err); }
});

app.patch('/api/admin/clients/:id', requireAdmin, async (req, res, next) => {
  try {
    const existing = await getClientById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const b = req.body || {};
    const estadoCliente = ['activo', 'inactivo'].includes(b.estadoCliente) ? b.estadoCliente : (existing.estado_cliente || 'activo');
    const { rows } = await pool.query(
      `UPDATE clients SET
         nombre_fantasia = $2,
         razon_social    = $3,
         cuit            = $4,
         direccion       = $5,
         tel_admin       = $6,
         tel_dueno       = $7,
         mail1           = $8,
         mail2           = $9,
         vence           = $10,
         estado_cliente  = $11,
         descripcion     = $12,
         updated_at      = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        req.params.id,
        String(b.nombreFantasia || '').trim() || existing.nombre_fantasia,
        String(b.razonSocial || '').trim(),
        String(b.cuit || '').trim(),
        String(b.direccion || '').trim(),
        String(b.telAdmin || '').trim(),
        String(b.telDueno || '').trim(),
        String(b.mail1 || '').trim(),
        String(b.mail2 || '').trim(),
        cleanDate(b.vence),
        estadoCliente,
        String(b.descripcion || '').trim(),
      ]
    );
    const balances = await clientBalances();
    res.json({ client: clientDTO(rows[0], balances[rows[0].id] || { saldo: 0 }) });
  } catch (err) { next(err); }
});

// Soft-delete (mueve a papelera). El borrado fisico esta deshabilitado.
app.delete('/api/admin/clients/:id', requireAdmin, async (req, res, next) => {
  try {
    const r = await pool.query(
      `UPDATE clients SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Cliente no encontrado o ya estaba en la papelera.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Restaurar cliente de la papelera
app.post('/api/admin/clients/:id/restore', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE clients SET deleted_at = NULL, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NOT NULL
       RETURNING *`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Cliente no esta en la papelera.' });
    const balances = await clientBalances();
    res.json({ client: clientDTO(rows[0], balances[rows[0].id] || { saldo: 0 }) });
  } catch (err) { next(err); }
});

// Dashboard mensual de administración
app.get('/api/admin/dashboard', requireAdmin, async (req, res, next) => {
  try {
    const now = new Date();
    const year = parseInt(req.query.year || now.getFullYear(), 10);
    const month = parseInt(req.query.month || (now.getMonth() + 1), 10);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: 'Parámetros year/month inválidos.' });
    }

    const monthStr = String(month).padStart(2, '0');
    const prefix = `${year}-${monthStr}`;

    const [ingresosRes, pendientesRes] = await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM(monto_factura) FILTER (WHERE COALESCE(cm.medio_pago,'') != 'canje'), 0) AS ingresos_totales,
           COALESCE(SUM(haber)         FILTER (WHERE COALESCE(cm.medio_pago,'') != 'canje'), 0) AS cobrados
         FROM client_movements cm
         JOIN clients c ON c.id = cm.client_id
         WHERE c.deleted_at IS NULL
           AND cm.fecha LIKE $1`,
        [prefix + '%']
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(GREATEST(bal.saldo, 0)), 0)        AS pendientes,
           COUNT(*) FILTER (WHERE bal.saldo > 0 AND c.vence != '' AND c.vence < $1) AS vencidos
         FROM (
           SELECT client_id,
             COALESCE(SUM(monto_factura), 0) - COALESCE(SUM(haber), 0) AS saldo
           FROM client_movements GROUP BY client_id
         ) bal
         JOIN clients c ON c.id = bal.client_id
         WHERE c.deleted_at IS NULL`,
        [now.toISOString().slice(0, 10)]
      ),
    ]);

    res.json({
      year, month,
      ingresosTotales: Number(ingresosRes.rows[0].ingresos_totales),
      cobrados: Number(ingresosRes.rows[0].cobrados),
      pendientes: Number(pendientesRes.rows[0].pendientes),
      vencidos: Number(pendientesRes.rows[0].vencidos),
    });
  } catch (err) { next(err); }
});

// Eliminacion definitiva deshabilitada: los clientes solo se mandan a papelera y se pueden restaurar.
app.delete('/api/admin/clients/:id/purge', requireAdmin, (_req, res) => {
  res.status(405).json({ error: 'La eliminacion definitiva esta deshabilitada. Restaurar desde la papelera.' });
});

app.get('/api/admin/clients/:id/movements', requireAdmin, async (req, res, next) => {
  try {
    const client = await getClientById(req.params.id);
    if (!client) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const { rows } = await pool.query(
      `SELECT * FROM client_movements
       WHERE client_id = $1
       ORDER BY fecha ASC, creado_en ASC`,
      [req.params.id]
    );
    let saldo = 0;
    const movements = rows.map((r) => {
      saldo += Number(r.monto_factura || 0) - Number(r.haber || 0);
      const dto = movementDTO(r, saldo);
      // incluir data de archivos para mostrar en el cliente
      dto.archivos = Array.isArray(r.archivos) ? r.archivos : [];
      return dto;
    });
    res.json({
      client: clientDTO(client, { saldo }),
      movements,
    });
  } catch (err) { next(err); }
});

app.post('/api/admin/clients/:id/movements', requireAdmin, async (req, res, next) => {
  try {
    const client = await getClientById(req.params.id);
    if (!client) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const b = req.body || {};
    const fecha = cleanDate(b.fecha);
    if (!fecha) return res.status(400).json({ error: 'Fecha invalida (YYYY-MM-DD).' });

    const medioPago = String(b.medioPago || '').toLowerCase().trim();
    if (!ALLOWED_MEDIO_PAGO.has(medioPago)) {
      return res.status(400).json({ error: 'Medio de pago invalido.' });
    }

    const debe = cleanMoney(b.debe);
    const haber = cleanMoney(b.haber);
    const monto = cleanMoney(b.montoFactura);
    if (debe === 0 && haber === 0) {
      return res.status(400).json({ error: 'Ingresa al menos un monto en Debe o Haber.' });
    }

    const archivos = cleanArchivosMovementWithData(b.archivos || []);

    const id = mkId();
    const creadoEn = Date.now();
    await pool.query(
      `INSERT INTO client_movements (
         id, client_id, fecha, medio_pago, banco, detalle,
         monto_factura, debe, haber, creado_por, creado_en, archivos
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [
        id, req.params.id, fecha, medioPago,
        String(b.banco || '').trim(),
        String(b.detalle || '').trim(),
        monto, debe, haber, req.user.id, creadoEn,
        JSON.stringify(archivos),
      ]
    );
    res.status(201).json({ ok: true, id });
  } catch (err) { next(err); }
});

app.patch('/api/admin/clients/:id/movements/:movId', requireAdmin, async (req, res, next) => {
  try {
    const { rows: ex } = await pool.query(
      'SELECT * FROM client_movements WHERE id = $1 AND client_id = $2',
      [req.params.movId, req.params.id]
    );
    if (!ex[0]) return res.status(404).json({ error: 'Movimiento no encontrado.' });
    const b = req.body || {};
    const fecha = cleanDate(b.fecha);
    if (!fecha) return res.status(400).json({ error: 'Fecha invalida (YYYY-MM-DD).' });
    const medioPago = String(b.medioPago || '').toLowerCase().trim();
    if (!ALLOWED_MEDIO_PAGO.has(medioPago)) return res.status(400).json({ error: 'Medio de pago invalido.' });
    const debe = cleanMoney(b.debe);
    const haber = cleanMoney(b.haber);
    const monto = cleanMoney(b.montoFactura);
    if (debe === 0 && haber === 0) return res.status(400).json({ error: 'Ingresa al menos un monto en Debe o Haber.' });
    const archivos = cleanArchivosMovementWithData(b.archivos || []);
    await pool.query(
      `UPDATE client_movements SET
         fecha=$1, medio_pago=$2, banco=$3, detalle=$4,
         monto_factura=$5, debe=$6, haber=$7, archivos=$8::jsonb
       WHERE id=$9 AND client_id=$10`,
      [
        fecha, medioPago,
        String(b.banco || '').trim(),
        String(b.detalle || '').trim(),
        monto, debe, haber,
        JSON.stringify(archivos),
        req.params.movId, req.params.id,
      ]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.delete('/api/admin/clients/:id/movements/:movId', requireAdmin, async (req, res, next) => {
  try {
    const r = await pool.query(
      'DELETE FROM client_movements WHERE id = $1 AND client_id = $2',
      [req.params.movId, req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Movimiento no encontrado.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.patch('/api/profile', requireAuth, async (req, res, next) => {
  try {
    // Preferencia de guardado automatico: actualizacion aislada (no toca nombre/avatar)
    if ('autosaveCards' in req.body && req.body.nombre === undefined) {
      await pool.query(
        'UPDATE users SET autosave_cards = $1, updated_at = NOW() WHERE id = $2',
        [req.body.autosaveCards === true, req.user.id]
      );
      const updated = await getUserById(req.user.id);
      return res.json({ user: userDTO(updated) });
    }

    const nombre = String(req.body.nombre || '').trim();
    const apellido = String(req.body.apellido || '').trim();
    const password = String(req.body.password || '');
    const avatarImage = cleanAvatarImage(req.body.avatarImage ?? req.user.avatar_image);
    if (!nombre) return res.status(400).json({ error: 'El nombre no puede estar vacio.' });

    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Contrasena minimo 6 caracteres.' });
      const passwordHash = await bcrypt.hash(password, 12);
      await pool.query(
        'UPDATE users SET nombre = $1, apellido = $2, password_hash = $3, avatar_image = $4, updated_at = NOW() WHERE id = $5',
        [nombre, apellido, passwordHash, avatarImage, req.user.id]
      );
    } else {
      await pool.query(
        'UPDATE users SET nombre = $1, apellido = $2, avatar_image = $3, updated_at = NOW() WHERE id = $4',
        [nombre, apellido, avatarImage, req.user.id]
      );
    }

    const updated = await getUserById(req.user.id);
    res.json({ user: userDTO(updated) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/users', requireAuth, async (req, res, next) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Solo administradores pueden crear usuarios.' });
    const username = cleanUsername(req.body.username);
    const nombre = String(req.body.nombre || '').trim();
    const apellido = String(req.body.apellido || '').trim();
    const password = String(req.body.password || '');
    const equipo = cleanTeam(req.body.equipo);
    if (!username || !nombre || !password || !equipo) return res.status(400).json({ error: 'Completa todos los campos.' });
    if (password.length < 6) return res.status(400).json({ error: 'Contrasena minimo 6 caracteres.' });

    const { rows } = await pool.query(
      `INSERT INTO users (id, username, nombre, apellido, password_hash, equipo)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, username, nombre, apellido, equipo`,
      [mkId(), username, nombre, apellido, await bcrypt.hash(password, 12), equipo]
    );
    res.status(201).json({ user: userDTO(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una cuenta con ese usuario.' });
    next(err);
  }
});

app.patch('/api/users/:id', requireAuth, async (req, res, next) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Solo administradores pueden editar usuarios.' });
    const { id } = req.params;
    const nombre = String(req.body.nombre || '').trim();
    const apellido = String(req.body.apellido || '').trim();
    const username = cleanUsername(req.body.username);
    const equipo = cleanTeam(req.body.equipo);
    const password = req.body.password ? String(req.body.password) : null;
    if (!nombre || !username || !equipo) return res.status(400).json({ error: 'Completa todos los campos.' });
    if (password && password.length < 6) return res.status(400).json({ error: 'Contrasena minimo 6 caracteres.' });
    const values = [id, nombre, apellido, username, equipo];
    const sets = ['nombre=$2', 'apellido=$3', 'username=$4', 'equipo=$5', 'updated_at=NOW()'];
    if (password) { sets.push(`password_hash=$${values.length + 1}`); values.push(await bcrypt.hash(password, 12)); }
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id=$1 RETURNING id, username, nombre, apellido, equipo, avatar_image`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado.' });
    res.json({ user: userDTO(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una cuenta con ese usuario.' });
    next(err);
  }
});

app.delete('/api/users/:id', requireAuth, async (req, res, next) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Solo administradores pueden eliminar usuarios.' });
    const { id } = req.params;
    if (id === req.user.id) return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta.' });
    await pool.query(
      `UPDATE cards
       SET usuarios = COALESCE(
             (SELECT jsonb_agg(to_jsonb(x.value)) FROM jsonb_array_elements_text(usuarios) AS x(value) WHERE x.value <> $1),
             '[]'::jsonb
           ),
           checklist = COALESCE(
             (SELECT jsonb_agg(CASE WHEN item->>'usuario' = $1 THEN item - 'usuario' ELSE item END)
              FROM jsonb_array_elements(checklist) AS item),
             '[]'::jsonb
           )
       WHERE usuarios ? $1 OR checklist @> $2::jsonb`,
      [id, JSON.stringify([{ usuario: id }])]
    );
    const { rowCount } = await pool.query('DELETE FROM users WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Usuario no encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

function eventDTO(r) {
  return {
    id: r.id, titulo: r.titulo, descripcion: r.descripcion,
    fecha: r.fecha, horaInicio: r.hora_inicio, horaFin: r.hora_fin,
    equipo: r.equipo, color: r.color, creadoPor: r.creado_por, creadoEn: r.creado_en,
  };
}

app.post('/api/events', requireAuth, async (req, res, next) => {
  try {
    const titulo = String(req.body.titulo || '').trim();
    const descripcion = String(req.body.descripcion || '').trim();
    const fecha = String(req.body.fecha || '').trim();
    const horaInicio = String(req.body.horaInicio || '').trim();
    const horaFin = String(req.body.horaFin || '').trim();
    const equipo = cleanTeam(req.body.equipo) || req.user.equipo;
    const color = String(req.body.color || 'blue').trim();
    if (!titulo || !fecha) return res.status(400).json({ error: 'Titulo y fecha son requeridos.' });
    if (!canAccessTeam(req.user, equipo)) return res.status(403).json({ error: 'Sin acceso a ese equipo.' });
    const { rows } = await pool.query(
      `INSERT INTO calendar_events (id,titulo,descripcion,fecha,hora_inicio,hora_fin,equipo,color,creado_por,creado_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [mkId(), titulo, descripcion, fecha, horaInicio, horaFin, equipo, color, req.user.id, Date.now()]
    );
    res.status(201).json({ event: eventDTO(rows[0]) });
  } catch (err) { next(err); }
});

app.patch('/api/events/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows: ex } = await pool.query('SELECT * FROM calendar_events WHERE id=$1', [req.params.id]);
    if (!ex.length) return res.status(404).json({ error: 'Evento no encontrado.' });
    if (ex[0].creado_por !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'Sin permiso para editar este evento.' });
    const titulo = String(req.body.titulo || '').trim();
    const descripcion = String(req.body.descripcion || '').trim();
    const fecha = String(req.body.fecha || '').trim();
    const horaInicio = String(req.body.horaInicio || '').trim();
    const horaFin = String(req.body.horaFin || '').trim();
    const equipo = cleanTeam(req.body.equipo) || ex[0].equipo;
    const color = String(req.body.color || ex[0].color).trim();
    if (!titulo || !fecha) return res.status(400).json({ error: 'Titulo y fecha son requeridos.' });
    if (!canAccessTeam(req.user, equipo)) return res.status(403).json({ error: 'Sin acceso a ese equipo.' });
    const { rows } = await pool.query(
      `UPDATE calendar_events SET titulo=$2,descripcion=$3,fecha=$4,hora_inicio=$5,hora_fin=$6,equipo=$7,color=$8 WHERE id=$1 RETURNING *`,
      [req.params.id, titulo, descripcion, fecha, horaInicio, horaFin, equipo, color]
    );
    res.json({ event: eventDTO(rows[0]) });
  } catch (err) { next(err); }
});

app.delete('/api/events/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT creado_por FROM calendar_events WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Evento no encontrado.' });
    if (rows[0].creado_por !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'Sin permiso para eliminar este evento.' });
    await pool.query('DELETE FROM calendar_events WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ─────────────────────────────────────────
   GOOGLE CALENDAR (eventos editables via service account)
───────────────────────────────────────── */

// Colores de la app <-> colorId de Google Calendar.
const COLOR_TO_GCAL = {
  blue: '7', purple: '3', green: '10', red: '11',
  orange: '6', pink: '4', teal: '2', yellow: '5',
};
const GCAL_TO_COLOR = {
  1: 'purple', 2: 'teal', 3: 'purple', 4: 'pink', 5: 'yellow', 6: 'orange',
  7: 'blue', 8: 'blue', 9: 'blue', 10: 'green', 11: 'red',
};

function hhmm(value) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value || '').trim());
  if (!m) return '';
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function isoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim()) ? value.trim() : '';
}

function addOneHour(time) {
  const [h, m] = time.split(':').map(Number);
  const total = (h * 60 + m + 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function nextDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Construye el recurso de evento para la API de Google a partir del body del front.
function buildGcalResource(body) {
  const titulo = String(body.titulo || '').trim();
  const descripcion = String(body.descripcion || '').trim();
  const fecha = isoDate(body.fecha);
  const horaInicio = hhmm(body.horaInicio);
  const horaFin = hhmm(body.horaFin);
  const color = COLOR_TO_GCAL[String(body.color || 'blue').trim()];

  const resource = { summary: titulo, description: descripcion };
  if (color) resource.colorId = color;

  if (horaInicio) {
    const end = horaFin || addOneHour(horaInicio);
    resource.start = { dateTime: `${fecha}T${horaInicio}:00`, timeZone: GOOGLE_CALENDAR_CTZ };
    resource.end = { dateTime: `${fecha}T${end}:00`, timeZone: GOOGLE_CALENDAR_CTZ };
  } else {
    resource.start = { date: fecha };
    resource.end = { date: nextDay(fecha) };
  }
  return resource;
}

// Convierte un evento de Google al DTO que entiende el front.
function gcalEventToDTO(ev, team) {
  const startDT = ev.start && ev.start.dateTime;
  const endDT = ev.end && ev.end.dateTime;
  let fecha = '';
  let horaInicio = '';
  let horaFin = '';
  if (startDT) {
    fecha = startDT.slice(0, 10);
    horaInicio = startDT.slice(11, 16);
    if (endDT) horaFin = endDT.slice(11, 16);
  } else {
    fecha = (ev.start && ev.start.date) || '';
  }
  return {
    id: ev.id,
    titulo: ev.summary || '(sin titulo)',
    descripcion: ev.description || '',
    fecha,
    horaInicio,
    horaFin,
    equipo: team,
    color: GCAL_TO_COLOR[Number(ev.colorId)] || 'blue',
    htmlLink: ev.htmlLink || '',
    source: 'google',
  };
}

// Rango [timeMin, timeMax) para un mes 'YYYY-MM' (con un dia de colchon por zona horaria).
function monthRange(monthStr) {
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(monthStr || ''));
  const now = new Date();
  const year = m ? Number(m[1]) : now.getFullYear();
  const month = m ? Number(m[2]) - 1 : now.getMonth();
  const start = new Date(Date.UTC(year, month, 1));
  start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(Date.UTC(year, month + 1, 1));
  end.setUTCDate(end.getUTCDate() + 1);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

// Middleware comun: valida equipo, acceso, config y resuelve el calendarId.
async function gcalContext(req, res) {
  const equipo = cleanTeam(req.params.team);
  if (!equipo) { res.status(400).json({ error: 'Equipo invalido.' }); return null; }
  if (!canAccessTeam(req.user, equipo)) { res.status(403).json({ error: 'Sin acceso a ese equipo.' }); return null; }
  if (!gcal.isConfigured()) { res.status(503).json({ error: 'Google Calendar no esta configurado en el servidor.' }); return null; }
  const calendarId = await resolveTeamCalendarId(equipo);
  if (!calendarId) { res.status(400).json({ error: 'Este equipo no tiene un Google Calendar configurado.' }); return null; }
  return { equipo, calendarId };
}

app.get('/api/gcal/:team/events', requireAuth, async (req, res, next) => {
  try {
    const ctx = await gcalContext(req, res);
    if (!ctx) return;
    const { timeMin, timeMax } = monthRange(req.query.month);
    const items = await gcal.listEvents(ctx.calendarId, timeMin, timeMax);
    res.json({ events: items.map((ev) => gcalEventToDTO(ev, ctx.equipo)) });
  } catch (err) { next(err); }
});

app.post('/api/gcal/:team/events', requireAuth, async (req, res, next) => {
  try {
    const ctx = await gcalContext(req, res);
    if (!ctx) return;
    if (!String(req.body.titulo || '').trim() || !isoDate(req.body.fecha)) {
      return res.status(400).json({ error: 'Titulo y fecha son requeridos.' });
    }
    const ev = await gcal.createEvent(ctx.calendarId, buildGcalResource(req.body));
    res.status(201).json({ event: gcalEventToDTO(ev, ctx.equipo) });
  } catch (err) { next(err); }
});

app.patch('/api/gcal/:team/events/:eventId', requireAuth, async (req, res, next) => {
  try {
    const ctx = await gcalContext(req, res);
    if (!ctx) return;
    if (!String(req.body.titulo || '').trim() || !isoDate(req.body.fecha)) {
      return res.status(400).json({ error: 'Titulo y fecha son requeridos.' });
    }
    const ev = await gcal.updateEvent(ctx.calendarId, req.params.eventId, buildGcalResource(req.body));
    res.json({ event: gcalEventToDTO(ev, ctx.equipo) });
  } catch (err) { next(err); }
});

app.delete('/api/gcal/:team/events/:eventId', requireAuth, async (req, res, next) => {
  try {
    const ctx = await gcalContext(req, res);
    if (!ctx) return;
    await gcal.deleteEvent(ctx.calendarId, req.params.eventId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/cards', requireAuth, async (req, res, next) => {
  try {
    const data = cardValues(req.body, req.user);
    validateCardRequired(data);
    data.usuarios = await validateAssignedUsers(req.user, data.usuarios, data.equipo);
    data.usuario = data.usuarios[0] || null;
    data.checklist = await validateChecklistUsers(req.user, data.checklist, data.equipo);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cardId = mkId();
      const creadoEn = Date.now();
      const { rows } = await client.query(
        `INSERT INTO cards (
          id, nf, rs, cuit, ca, ntel, t, ta, c, color, estado, equipo, usuario,
          usuarios, creado_por, creado_en, debe, monto_deuda, vence, vence_hora, cover_image, checklist, pauta_url, attachments
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23,$24::jsonb)
        RETURNING *`,
        [
          cardId, data.nf, data.rs, data.cuit, data.ca, data.ntel, data.t, data.ta, data.c,
          data.color, data.estado, data.equipo, data.usuario, JSON.stringify(data.usuarios), req.user.id, creadoEn,
          data.debe, data.montoDeuda, data.vence, data.venceHora, data.coverImage, JSON.stringify(data.checklist), data.pautaUrl,
          JSON.stringify(data.attachments),
        ]
      );
      const history = [];
      if (data.c.trim()) {
        history.push(await insertDescriptionHistory(client, cardId, req.user.id, data.c, creadoEn, 'descripcion'));
      }
      if (data.vence) {
        history.push(await insertDescriptionHistory(
          client, cardId, req.user.id,
          fmtVenceForActivity(data.vence, data.venceHora),
          creadoEn, 'vencimiento'
        ));
      }
      await client.query('COMMIT');
      const card = cardDTO(rows[0], history);
      cardEvents.emit('change', { action: 'create', card });
      res.status(201).json({ card });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { });
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// Reordenar cards dentro de una columna (DEBE estar antes de /api/cards/:id)
app.put('/api/cards/reorder', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const equipo = cleanTeam(req.body.equipo);
    const estado = String(req.body.estado || '');
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
    if (!equipo) return res.status(400).json({ error: 'Equipo invalido.' });
    const isVentas = (equipo === 'ventas');
    const validStatuses = isVentas
      ? ['contactado', 'presupuestado', 'reunion', 'venta_exitosa', 'papelera']
      : ['iniciada', 'en_proceso', 'finalizado'];
    if (!validStatuses.includes(estado)) return res.status(400).json({ error: 'Estado invalido.' });
    if (!canAccessTeam(req.user, equipo)) return res.status(403).json({ error: 'Sin permiso.' });
    if (!ids.length) return res.json({ ok: true });

    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query(
        `UPDATE cards SET position = $1, updated_at = NOW()
         WHERE id = $2 AND equipo = $3 AND estado = $4`,
        [i + 1, ids[i], equipo, estado]
      );
    }
    await client.query('COMMIT');
    cardEvents.emit('change', { action: 'reorder', equipo, estado, ids });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    next(err);
  } finally {
    client.release();
  }
});

app.put('/api/cards/:id', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM cards WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!current.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Tarjeta no encontrada.' });
    }
    if (!canAccessTeam(req.user, current.rows[0].equipo)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Sin permiso.' });
    }
    const data = cardValues(req.body, req.user, current.rows[0]);
    validateCardRequired(data);
    data.usuarios = await validateAssignedUsers(req.user, data.usuarios, data.equipo);
    data.usuario = data.usuarios[0] || null;
    data.checklist = await validateChecklistUsers(req.user, data.checklist, data.equipo);
    const { rows } = await client.query(
      `UPDATE cards SET
        nf=$1, rs=$2, cuit=$3, ca=$4, ntel=$5, t=$6, ta=$7, c=$8, color=$9,
        estado=$10, equipo=$11, usuario=$12, usuarios=$13::jsonb, debe=$14, monto_deuda=$15, vence=$16,
        vence_hora=$17, cover_image=$18, checklist=$19::jsonb, pauta_url=$20, attachments=$21::jsonb, updated_at=NOW()
       WHERE id=$22
       RETURNING *`,
      [
        data.nf, data.rs, data.cuit, data.ca, data.ntel, data.t, data.ta, data.c, data.color,
        data.estado, data.equipo, data.usuario, JSON.stringify(data.usuarios), data.debe, data.montoDeuda, data.vence,
        data.venceHora, data.coverImage, JSON.stringify(data.checklist), data.pautaUrl,
        JSON.stringify(data.attachments), req.params.id,
      ]
    );
    if (String(data.c) !== String(current.rows[0].c || '')) {
      await insertDescriptionHistory(client, req.params.id, req.user.id, data.c, Date.now(), 'descripcion');
    }
    const prevVence = String(current.rows[0].vence || '');
    const prevVenceHora = String(current.rows[0].vence_hora || '');
    if (String(data.vence) !== prevVence || String(data.venceHora) !== prevVenceHora) {
      await insertDescriptionHistory(
        client, req.params.id, req.user.id,
        fmtVenceForActivity(data.vence, data.venceHora),
        Date.now(), 'vencimiento'
      );
    }
    const historyByCard = await descriptionHistoryByCardIds([req.params.id], client);
    await client.query('COMMIT');
    const card = cardDTO(rows[0], historyByCard.get(req.params.id) || []);
    cardEvents.emit('change', { action: 'update', card });
    res.json({ card });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    next(err);
  } finally {
    client.release();
  }
});

app.post('/api/external/cards/update-status', requireExternalAuth, async (req, res, next) => {
  const { phone, cardId, estado, motivo, createIfMissing, nombreFiscal, razonSocial, cuit } = req.body;

  if (!estado) {
    return res.status(400).json({ error: 'El campo "estado" es obligatorio.' });
  }

  const validStatuses = ['contactado', 'presupuestado', 'reunion', 'venta_exitosa', 'papelera'];
  if (!validStatuses.includes(estado)) {
    return res.status(400).json({
      error: `Estado inválido. Debe ser uno de: ${validStatuses.join(', ')}`
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let targetCardId = null;

    if (cardId) {
      const { rows } = await client.query(
        "SELECT id FROM cards WHERE id = $1 AND equipo = 'ventas' AND deleted_at IS NULL",
        [cardId]
      );
      if (rows[0]) {
        targetCardId = rows[0].id;
      }
    } else if (phone) {
      // Usar la misma lógica de correspondencia de número telefónico de WhatsApp
      const { rows } = await client.query(
        "SELECT id, ntel FROM cards WHERE equipo = 'ventas' AND deleted_at IS NULL"
      );

      const cleanDigits = (p) => String(p || '').replace(/\D/g, '');
      const cleanLocal = (p) => {
        let s = p;
        if (s.startsWith('549')) s = s.slice(3);
        else if (s.startsWith('54')) s = s.slice(2);
        if (s.startsWith('0')) s = s.slice(1);
        if (s.length === 10 && s.startsWith('15')) s = s.slice(2);
        return s;
      };

      const incomingClean = cleanDigits(phone);
      const incomingLocal = cleanLocal(incomingClean);

      const matched = rows.find((row) => {
        const cardClean = cleanDigits(row.ntel);
        const cardLocal = cleanLocal(cardClean);
        if (!cardClean || !incomingClean) return false;
        return cardClean === incomingClean || (cardLocal === incomingLocal && cardLocal.length >= 7);
      });

      if (matched) {
        targetCardId = matched.id;
      }
    } else {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Se requiere "phone" o "cardId" para identificar la tarjeta.' });
    }

    let cardRow = null;

    if (targetCardId) {
      // 1. Actualizar estado
      const { rows } = await client.query(
        `UPDATE cards SET estado = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [estado, targetCardId]
      );
      cardRow = rows[0];

      // 2. Registrar en historial de comentarios
      const logMessage = `Movido automáticamente por n8n. Motivo: ${motivo || 'Requisitos cumplidos'}`;
      await insertDescriptionHistory(client, targetCardId, 'system-bot', logMessage, Date.now(), 'comentario');
    } else if (createIfMissing) {
      // Crear nueva tarjeta si no existe
      if (!phone) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Se requiere "phone" para poder crear una tarjeta inexistente.' });
      }

      const nf = nombreFiscal || `Lead Externo (${phone})`;
      const rs = razonSocial || '';
      const c = motivo ? `Creado automáticamente por n8n. Motivo: ${motivo}` : 'Creado automáticamente por n8n.';
      const newCardId = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
      const creadoEn = Date.now();

      // Resolver avatar de WhatsApp si el servicio está listo
      let coverImage = '';
      try {
        if (whatsappService.getStatus() === 'READY') {
          const jid = await whatsappService.resolvePhoneLid(phone);
          coverImage = await whatsappService.getProfilePictureBase64(jid);
        }
      } catch (picErr) {
        console.error('[External Lead Create Picture Error]', picErr);
      }

      const { rows } = await client.query(
        `INSERT INTO cards (
          id, nf, rs, cuit, ca, ntel, t, ta, c, color, estado, equipo, creado_en, cover_image
        ) VALUES ($1, $2, $3, $4, '', $5, '', '', $6, 'none', $7, 'ventas', $8, $9)
        RETURNING *`,
        [newCardId, nf, rs, cuit || '', phone, c, estado, creadoEn, coverImage]
      );
      cardRow = rows[0];
      targetCardId = newCardId;

      // Historial de creación/comentario
      await insertDescriptionHistory(client, targetCardId, 'system-bot', c, creadoEn, 'comentario');
    } else {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Tarjeta no encontrada y "createIfMissing" es false.' });
    }

    const historyByCard = await descriptionHistoryByCardIds([targetCardId], client);
    await client.query('COMMIT');

    const card = cardDTO(cardRow, historyByCard.get(targetCardId) || []);
    // Emitir el evento de cambio por SSE en tiempo real
    cardEvents.emit('change', { action: 'update', card });

    res.json({ ok: true, action: targetCardId === cardId || targetCardId !== cardRow.id ? 'update' : 'create', card });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ── Helpers fecha Argentina ──
function todayInArgentina() {
  // YYYY-MM-DD usando America/Argentina/Cordoba (UTC-3, sin DST)
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Cordoba',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date()); // ya viene YYYY-MM-DD
}

// Toggle del check diario de una card
app.post('/api/cards/:id/daily-check', requireAuth, async (req, res, next) => {
  try {
    const { rows: cur } = await pool.query(
      'SELECT equipo, daily_check_date FROM cards WHERE id = $1',
      [req.params.id]
    );
    if (!cur[0]) return res.status(404).json({ error: 'Card no encontrada.' });
    if (!canAccessTeam(req.user, cur[0].equipo)) return res.status(403).json({ error: 'Sin permiso.' });

    const today = todayInArgentina();
    const wasOn = String(cur[0].daily_check_date || '') === today;
    const newVal = wasOn ? '' : today;

    await pool.query(
      'UPDATE cards SET daily_check_date = $1, updated_at = NOW() WHERE id = $2',
      [newVal, req.params.id]
    );
    cardEvents.emit('change', { action: 'daily-check', id: req.params.id, dailyCheckDate: newVal });
    res.json({ id: req.params.id, dailyCheckDate: newVal, today });
  } catch (err) { next(err); }
});

app.put('/api/calendars/:team', requireAuth, async (req, res, next) => {
  try {
    const equipo = cleanTeam(req.params.team);
    if (!equipo) return res.status(400).json({ error: 'Equipo invalido.' });
    if (!canAccessTeam(req.user, equipo)) return res.status(403).json({ error: 'Sin permiso.' });

    const googleCalendarUrl = cleanCalendarUrl(req.body.googleCalendarUrl);
    const { rows } = await pool.query(
      `INSERT INTO team_calendars (equipo, google_calendar_url, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (equipo) DO UPDATE SET
         google_calendar_url = EXCLUDED.google_calendar_url,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING equipo, google_calendar_url`,
      [equipo, googleCalendarUrl, req.user.id]
    );

    res.json({
      calendar: {
        equipo: rows[0].equipo,
        googleCalendarUrl: rows[0].google_calendar_url,
        editable: gcal.isConfigured() && !!calendarIdFromUrl(rows[0].google_calendar_url),
      },
    });
  } catch (err) {
    next(err);
  }
});

// Soft-delete (papelera). El borrado fisico esta deshabilitado.
app.delete('/api/cards/:id', requireAuth, async (req, res, next) => {
  try {
    const current = await pool.query('SELECT equipo, deleted_at FROM cards WHERE id = $1', [req.params.id]);
    if (!current.rows[0]) return res.status(404).json({ error: 'Tarjeta no encontrada.' });
    if (!canAccessTeam(req.user, current.rows[0].equipo)) return res.status(403).json({ error: 'Sin permiso.' });
    if (current.rows[0].deleted_at) return res.status(400).json({ error: 'La tarjeta ya esta en la papelera.' });
    const { rows } = await pool.query(
      `UPDATE cards SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tarjeta no encontrada.' });
    const card = cardDTO(rows[0]);
    cardEvents.emit('change', { action: 'delete', id: req.params.id, card });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Listar papelera de tarjetas (segun equipos visibles del usuario)
app.get('/api/cards/trash', requireAuth, async (req, res, next) => {
  try {
    res.json({ cards: await trashedCards(req.user) });
  } catch (err) { next(err); }
});

// Restaurar tarjeta desde papelera
app.post('/api/cards/:id/restore', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT * FROM cards WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!current.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Tarjeta no encontrada.' });
    }
    if (!canAccessTeam(req.user, current.rows[0].equipo)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Sin permiso.' });
    }
    if (!current.rows[0].deleted_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'La tarjeta no esta en la papelera.' });
    }
    const { rows } = await client.query(
      `UPDATE cards SET deleted_at = NULL, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    const historyByCard = await descriptionHistoryByCardIds([req.params.id], client);
    await client.query('COMMIT');
    const card = cardDTO(rows[0], historyByCard.get(req.params.id) || []);
    cardEvents.emit('change', { action: 'restore', card });
    res.json({ card });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    next(err);
  } finally {
    client.release();
  }
});

// Eliminar definitivamente una tarjeta que ya esta en la papelera
app.delete('/api/cards/:id/purge', requireAuth, async (req, res, next) => {
  try {
    const current = await pool.query('SELECT equipo, deleted_at FROM cards WHERE id = $1', [req.params.id]);
    if (!current.rows[0]) return res.status(404).json({ error: 'Tarjeta no encontrada.' });
    if (!canAccessTeam(req.user, current.rows[0].equipo)) return res.status(403).json({ error: 'Sin permiso.' });
    if (!current.rows[0].deleted_at) return res.status(400).json({ error: 'La tarjeta no esta en la papelera.' });
    await pool.query('DELETE FROM cards WHERE id = $1', [req.params.id]);
    cardEvents.emit('change', { action: 'purge', id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Ruta API no encontrada.' });
});

// Assets estáticos (logo, favicons). Se sirven explícitamente para no exponer
// el resto del directorio (server.js, .env, db/, node_modules, etc.).
const STATIC_FILES = ['logo.webp', 'favicon.svg', 'favicon.png'];
for (const file of STATIC_FILES) {
  app.get('/' + file, (_req, res) => res.sendFile(path.join(__dirname, file)));
}
app.get('/favicon.ico', (_req, res) => res.sendFile(path.join(__dirname, 'favicon.png')));

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Error interno.' });
});

function cleanPhoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function phoneLocalForm(phone) {
  let s = cleanPhoneDigits(phone);
  if (s.startsWith('549')) s = s.slice(3);
  else if (s.startsWith('54')) s = s.slice(2);
  if (s.startsWith('0')) s = s.slice(1);
  if (s.length === 10 && s.startsWith('15')) s = s.slice(2);
  return s;
}

async function salesLeadExistsByPhone(phone) {
  const incomingClean = cleanPhoneDigits(phone);
  const incomingLocal = phoneLocalForm(incomingClean);

  if (!incomingClean) return true;

  const { rows } = await pool.query(
    "SELECT ntel FROM cards WHERE equipo = 'ventas' AND deleted_at IS NULL"
  );

  return rows.some((row) => {
    const cardClean = cleanPhoneDigits(row.ntel);
    const cardLocal = phoneLocalForm(cardClean);
    if (!cardClean) return false;
    return cardClean === incomingClean || (cardLocal === incomingLocal && cardLocal.length >= 7);
  });
}

async function salesLeadExistsByLid(lidAlias) {
  if (!lidAlias) return true;
  const { rows } = await pool.query(
    "SELECT id FROM cards WHERE equipo = 'ventas' AND deleted_at IS NULL AND whatsapp_lid_alias = $1 LIMIT 1",
    [lidAlias]
  );
  return !!rows[0];
}

async function ensureWhatsappLead({ jid, phone = '', lidAlias = '', body = '', pushName = '', timestamp = Date.now() }) {
  if (phone && phone.includes('@')) return null;
  if (!phone && !lidAlias) return null;

  const exists = phone ? await salesLeadExistsByPhone(phone) : await salesLeadExistsByLid(lidAlias);
  if (exists) return null;

  console.log(`[WhatsApp Lead] Creando nuevo lead para ${phone ? `numero: ${phone}` : `LID temporal: ${lidAlias}`}`);
  const cardId = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  const creadoEn = Number(timestamp) > 1000000000000 ? Number(timestamp) : Date.now();
  const nf = pushName ? pushName : (phone ? `WhatsApp Lead (${phone})` : 'WhatsApp Lead');

  let coverImage = '';
  try {
    coverImage = await whatsappService.getProfilePictureBase64(jid);
  } catch (picErr) {
    console.error('[WhatsApp Lead Picture Error] No se pudo obtener la imagen de perfil:', picErr);
  }

  const { rows: inserted } = await pool.query(
    `INSERT INTO cards (
      id, nf, rs, cuit, ca, ntel, t, ta, c, color, estado, equipo, creado_en, cover_image, whatsapp_lid_alias
    ) VALUES ($1, $2, '', '', '', $3, '', '', $4, 'none', 'contactado', 'ventas', $5, $6, $7)
    RETURNING *`,
    [cardId, nf, phone || '', `Mensaje recibido: "${body}"`, creadoEn, coverImage, lidAlias || '']
  );

  if (inserted[0]) {
    const card = cardDTO(inserted[0]);
    cardEvents.emit('change', { action: 'create', card });
    return card;
  }

  return null;
}

async function syncPendingLidLeads() {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (chat_jid) chat_jid, body, timestamp
     FROM whatsapp_messages
     WHERE from_me = false AND chat_jid LIKE '%@lid'
     ORDER BY chat_jid, timestamp DESC
     LIMIT 100`
  );

  for (const row of rows) {
    await ensureWhatsappLead({
      jid: row.chat_jid,
      lidAlias: row.chat_jid,
      body: row.body,
      timestamp: row.timestamp,
    });
  }
}

async function migrateVisibleLidNumbers() {
  const { rowCount } = await pool.query(
    `UPDATE cards c
     SET whatsapp_lid_alias = c.ntel || '@lid',
         ntel = '',
         updated_at = NOW()
     WHERE c.equipo = 'ventas'
       AND c.deleted_at IS NULL
       AND c.whatsapp_lid_alias = ''
       AND c.ntel ~ '^[0-9]+$'
       AND EXISTS (
         SELECT 1 FROM whatsapp_messages m WHERE m.chat_jid = c.ntel || '@lid'
       )`
  );

  if (rowCount > 0) {
    console.log(`[WhatsApp Lead] Se ocultaron ${rowCount} LID antiguos que estaban guardados como telefono.`);
  }
}

async function mergeChatAlias(lidJid, phoneJid) {
  const lidNumber = lidJid.split('@')[0];
  const realNumber = phoneJid.split('@')[0];

  console.log(`[WhatsApp Merge] Iniciando fusion para LID ${lidJid} (numero: ${lidNumber}) -> PN ${phoneJid} (numero: ${realNumber})`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Obtener todas las tarjetas activas de ventas asociadas al numero del LID
    const { rows: cardsToUpdate } = await client.query(
      "SELECT id, ntel FROM cards WHERE (ntel = $1 OR whatsapp_lid_alias = $2) AND equipo = 'ventas' AND deleted_at IS NULL",
      [lidNumber, lidJid]
    );

    if (cardsToUpdate.length > 0) {
      console.log(`[WhatsApp Merge] Encontradas ${cardsToUpdate.length} tarjetas con LID ${lidNumber}. Actualizando a ${realNumber}...`);
      
      // Actualizar ntel de las tarjetas
      await client.query(
        `UPDATE cards
         SET ntel = $1, whatsapp_lid_alias = '', updated_at = NOW()
         WHERE (ntel = $2 OR whatsapp_lid_alias = $3) AND equipo = 'ventas' AND deleted_at IS NULL`,
        [realNumber, lidNumber, lidJid]
      );

      // Emitir evento de cambio por cada tarjeta actualizada para que el cliente web refresque en tiempo real
      for (const cardRow of cardsToUpdate) {
        const { rows: updatedCard } = await client.query(
          "SELECT * FROM cards WHERE id = $1",
          [cardRow.id]
        );
        if (updatedCard[0]) {
          const card = cardDTO(updatedCard[0]);
          cardEvents.emit('change', { action: 'update', card });
        }
      }
    }

    // 2. Fusionar mensajes en whatsapp_messages
    const { rowCount: updatedMessages } = await client.query(
      `UPDATE whatsapp_messages
       SET chat_jid = CASE WHEN chat_jid = $2 THEN $1 ELSE chat_jid END,
           sender_jid = CASE WHEN sender_jid = $2 THEN $1 ELSE sender_jid END,
           receiver_jid = CASE WHEN receiver_jid = $2 THEN $1 ELSE receiver_jid END
       WHERE chat_jid = $2 OR sender_jid = $2 OR receiver_jid = $2`,
      [phoneJid, lidJid]
    );
    if (updatedMessages > 0) {
      console.log(`[WhatsApp Merge] Se actualizaron ${updatedMessages} mensajes de ${lidJid} a ${phoneJid}.`);
    }

    await client.query('COMMIT');
    console.log(`[WhatsApp Merge] Fusion exitosa para LID ${lidJid} -> PN ${phoneJid}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[WhatsApp Merge Error] Error al ejecutar fusion:', err);
  } finally {
    client.release();
  }
}

async function start() {
  try {
    await ensureDatabaseMigrations();
    await migrateVisibleLidNumbers();
    await syncPendingLidLeads();

    // Handler para recibir mensajes de WhatsApp y crear leads automáticamente si no existen
    whatsappService.events.on('message', async (msg) => {
      // Guardar mensaje en la base de datos
      const peerJid = msg.fromMe ? msg.to : msg.from;
      try {
        await pool.query(
          `INSERT INTO whatsapp_messages (id, chat_jid, sender_jid, receiver_jid, body, timestamp, from_me)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO NOTHING`,
          [msg.id, peerJid, msg.from, msg.to, msg.body || '', msg.timestamp, msg.fromMe]
        );
      } catch (dbErr) {
        console.error('[WhatsApp Service DB Error] No se pudo guardar el mensaje:', dbErr);
      }

      if (msg.fromMe) return;

      const jid = msg.from;
      const phone = whatsappService.extractPhoneNumberFromJid(jid);
      if (!phone) {
        console.log(`[WhatsApp Lead] Mensaje entrante con LID sin numero real (${jid}). Creando lead temporal sin telefono visible.`);
        try {
          await ensureWhatsappLead({
            jid,
            lidAlias: jid,
            body: msg.body,
            pushName: msg.pushName,
            timestamp: msg.timestamp,
          });
        } catch (err) {
          console.error('[WhatsApp Lead Error] No se pudo crear el lead temporal con LID:', err);
        }
        return;
      }

      try {
        // Consultar tarjetas activas de ventas
        const { rows } = await pool.query(
          "SELECT id, ntel FROM cards WHERE equipo = 'ventas' AND deleted_at IS NULL"
        );

        const cleanDigits = (p) => String(p || '').replace(/\D/g, '');
        const cleanLocal = (p) => {
          let s = p;
          if (s.startsWith('549')) s = s.slice(3);
          else if (s.startsWith('54')) s = s.slice(2);
          if (s.startsWith('0')) s = s.slice(1);
          if (s.length === 10 && s.startsWith('15')) s = s.slice(2);
          return s;
        };

        const incomingClean = cleanDigits(phone);
        const incomingLocal = cleanLocal(incomingClean);

        const exists = rows.some((row) => {
          const cardClean = cleanDigits(row.ntel);
          const cardLocal = cleanLocal(cardClean);
          if (!cardClean || !incomingClean) return false;
          return cardClean === incomingClean || (cardLocal === incomingLocal && cardLocal.length >= 7);
        });

        if (!exists) {
          console.log(`[WhatsApp Lead] Creando nuevo lead para número: ${phone}`);
          const cardId = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
          const creadoEn = Date.now();
          const nf = msg.pushName ? msg.pushName : `WhatsApp Lead (${phone})`;

          let coverImage = '';
          try {
            coverImage = await whatsappService.getProfilePictureBase64(jid);
          } catch (picErr) {
            console.error('[WhatsApp Lead Picture Error] No se pudo obtener la imagen de perfil:', picErr);
          }

          const { rows: inserted } = await pool.query(
            `INSERT INTO cards (
              id, nf, rs, cuit, ca, ntel, t, ta, c, color, estado, equipo, creado_en, cover_image
            ) VALUES ($1, $2, '', '', '', $3, '', '', $4, 'none', 'contactado', 'ventas', $5, $6)
            RETURNING *`,
            [cardId, nf, phone, `Mensaje recibido: "${msg.body}"`, creadoEn, coverImage]
          );

          if (inserted[0]) {
            const card = cardDTO(inserted[0]);
            cardEvents.emit('change', { action: 'create', card });
          }
        }
      } catch (err) {
        console.error('[WhatsApp Lead Error] No se pudo procesar el lead entrante:', err);
      }
    });

    // Escuchar la correspondencia de alias LID -> PN para realizar la fusion en base de datos
    whatsappService.events.on('lid_mapped', async ({ lid, pn }) => {
      console.log(`[WhatsApp Lead] Mapeo de LID detectado: ${lid} -> ${pn}. Sincronizando BD...`);
      await mergeChatAlias(lid, pn);

      const phone = whatsappService.extractPhoneNumberFromJid(pn);
      if (!phone) return;

      try {
        const { rows } = await pool.query(
          `SELECT sender_jid AS "from", body, timestamp
           FROM whatsapp_messages
           WHERE chat_jid = $1 AND from_me = false
           ORDER BY timestamp DESC
           LIMIT 1`,
          [pn]
        );

        if (rows[0]) {
          await ensureWhatsappLead({
            jid: pn,
            phone,
            body: rows[0].body,
            timestamp: rows[0].timestamp,
          });
        }
      } catch (err) {
        console.error('[WhatsApp Lead] Error creando lead luego del mapeo LID:', err);
      }
    });

    // Evento status de WhatsApp para sincronizar correspondencias de LID para leads activos
    whatsappService.events.on('status', async ({ status }) => {
      if (status === 'READY') {
        console.log('[WhatsApp Lead] Socket listo, mapeando leads activos...');
        try {
          const { rows } = await pool.query(
            "SELECT ntel FROM cards WHERE equipo = 'ventas' AND deleted_at IS NULL AND ntel IS NOT NULL AND ntel != ''"
          );
          console.log(`[WhatsApp Lead] Encontrados ${rows.length} números de leads activos para mapear.`);
          for (const row of rows) {
            try {
              console.log(`[WhatsApp Lead] Mapeando número: ${row.ntel}`);
              const resJid = await whatsappService.resolvePhoneLid(row.ntel);
              console.log(`[WhatsApp Lead] Mapeo para ${row.ntel} resuelto a JID: ${resJid}`);
            } catch (e) {
              console.error(`[WhatsApp Lead] Error mapeando número ${row.ntel}:`, e.message);
            }
          }
          console.log('[WhatsApp Lead] Mapeo de leads activos completado.');
        } catch (err) {
          console.error('[WhatsApp Lead] Error mapeando leads activos:', err);
        }
      }
    });

    // Inicializar servicio de WhatsApp en segundo plano
    whatsappService.init().catch(err => {
      console.error('[WhatsApp Service] Error al inicializar:', err);
    });

    app.listen(PORT, () => {
      console.log(`ConsultoriaDigital en http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('No se pudo preparar la base de datos:', err);
    process.exit(1);
  }
}

start();
