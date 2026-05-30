require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcrypt');
const express = require('express');
const { Pool } = require('pg');

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const PORT = Number(process.env.PORT || 3000);
const COOKIE_NAME = 'cd_session';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-change-me';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const GOOGLE_CALENDAR_CTZ = process.env.GOOGLE_CALENDAR_CTZ || 'America/Argentina/Buenos_Aires';

if (process.env.NODE_ENV === 'production' && SESSION_SECRET === 'dev-only-change-me') {
  throw new Error('Defini SESSION_SECRET en produccion.');
}

async function ensureDatabaseMigrations() {
  await pool.query("ALTER TABLE cards ADD COLUMN IF NOT EXISTS pauta_url TEXT NOT NULL DEFAULT ''");
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
}

app.use(express.json({ limit: '10mb' }));

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
  return isAdmin(user) ? ['marketing', 'desarrollo', 'admin'] : [user.equipo];
}

function canAccessTeam(user, team) {
  return allowedTeams(user).includes(team);
}

async function getUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
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
    nombreFantasia:  row.nombre_fantasia || '',
    razonSocial:     row.razon_social || '',
    cuit:            row.cuit || '',
    direccion:       row.direccion || '',
    telAdmin:        row.tel_admin || '',
    telDueno:        row.tel_dueno || '',
    mail1:           row.mail1 || '',
    mail2:           row.mail2 || '',
    vence:           row.vence || '',
    estadoCliente:   row.estado_cliente || 'activo',
    descripcion:     row.descripcion || '',
    cardId:          row.card_id || null,
    creadoPor:       row.creado_por || null,
    creadoEn:        Number(row.creado_en) || 0,
    deletedAt:       row.deleted_at ? row.deleted_at.toISOString() : null,
    saldo,
  };
}

function movementDTO(row, saldoAcumulado = null) {
  return {
    id: row.id,
    clientId:     row.client_id,
    fecha:        row.fecha || '',
    medioPago:    row.medio_pago || '',
    banco:        row.banco || '',
    detalle:      row.detalle || '',
    montoFactura: Number(row.monto_factura || 0),
    debe:         Number(row.debe || 0),
    haber:        Number(row.haber || 0),
    creadoPor:    row.creado_por || null,
    creadoEn:     Number(row.creado_en) || 0,
    saldoAcumulado: saldoAcumulado != null ? Number(saldoAcumulado) : null,
  };
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

const ALLOWED_MEDIO_PAGO = new Set(['efectivo', 'transferencia', 'cheque', 'echeque', 'tarjeta', '']);

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
  return Object.fromEntries(teams.map((team) => [team, calendarUrlFromEnv(team)]));
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
  return ['marketing', 'desarrollo', 'admin'].includes(value) ? value : '';
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
    estado: ['iniciada', 'en_proceso', 'finalizado'].includes(body.estado) ? body.estado : 'iniciada',
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

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const username = cleanUsername(req.body.username);
    const nombre = String(req.body.nombre || '').trim();
    const apellido = String(req.body.apellido || '').trim();
    const password = String(req.body.password || '');
    const equipo = cleanTeam(req.body.equipo);
    if (!username || !nombre || !password) return res.status(400).json({ error: 'Completa todos los campos.' });
    if (password.length < 6) return res.status(400).json({ error: 'Contrasena minimo 6 caracteres.' });
    if (!['marketing', 'desarrollo'].includes(equipo)) return res.status(400).json({ error: 'Equipo invalido.' });

    const id = mkId();
    const passwordHash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users (id, username, nombre, apellido, password_hash, equipo)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, username, nombre, apellido, equipo`,
      [id, username, nombre, apellido, passwordHash, equipo]
    );
    setSessionCookie(res, id);
    res.status(201).json({ user: userDTO(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una cuenta con ese usuario.' });
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
    res.json({
      user: userDTO(req.user),
      users: await visibleUsers(req.user),
      cards: await visibleCards(req.user),
      cardsTrash: await trashedCards(req.user),
      calendars: await visibleCalendars(req.user),
      events: await visibleEvents(req.user),
      notes: await visibleNotes(req.user),
      teams: allowedTeams(req.user),
      clients:         isAdmin ? await listClients()        : [],
      clientsTrash:    isAdmin ? await listTrashedClients() : [],
      libretaUrl:      isAdmin ? (process.env.LIBRETA_URL || '')       : '',
      flujoFondosUrl:  isAdmin ? (process.env.FLUJO_FONDOS_URL || '')  : '',
    });
  } catch (err) {
    next(err);
  }
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
    const year  = parseInt(req.query.year  || now.getFullYear(),  10);
    const month = parseInt(req.query.month || (now.getMonth() + 1), 10);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: 'Parámetros year/month inválidos.' });
    }

    const monthStr = String(month).padStart(2, '0');
    const prefix   = `${year}-${monthStr}`;

    const [ingresosRes, pendientesRes] = await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM(monto_factura), 0) AS ingresos_totales,
           COALESCE(SUM(haber), 0)         AS cobrados
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
           SELECT client_id, SUM(monto_factura) - SUM(haber) AS saldo
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
      cobrados:        Number(ingresosRes.rows[0].cobrados),
      pendientes:      Number(pendientesRes.rows[0].pendientes),
      vencidos:        Number(pendientesRes.rows[0].vencidos),
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
      // Saldo acumulado = factura - haber
      saldo += Number(r.monto_factura || 0) - Number(r.haber || 0);
      return movementDTO(r, saldo);
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

    const id = mkId();
    const creadoEn = Date.now();
    await pool.query(
      `INSERT INTO client_movements (
         id, client_id, fecha, medio_pago, banco, detalle,
         monto_factura, debe, haber, creado_por, creado_en
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id, req.params.id, fecha, medioPago,
        String(b.banco || '').trim(),
        String(b.detalle || '').trim(),
        monto, debe, haber, req.user.id, creadoEn,
      ]
    );
    res.status(201).json({ ok: true, id });
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
    const nombre   = String(req.body.nombre   || '').trim();
    const apellido = String(req.body.apellido || '').trim();
    const username = cleanUsername(req.body.username);
    const equipo   = cleanTeam(req.body.equipo);
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
    const titulo      = String(req.body.titulo      || '').trim();
    const descripcion = String(req.body.descripcion || '').trim();
    const fecha       = String(req.body.fecha       || '').trim();
    const horaInicio  = String(req.body.horaInicio  || '').trim();
    const horaFin     = String(req.body.horaFin     || '').trim();
    const equipo      = cleanTeam(req.body.equipo) || req.user.equipo;
    const color       = String(req.body.color || 'blue').trim();
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
    const titulo      = String(req.body.titulo      || '').trim();
    const descripcion = String(req.body.descripcion || '').trim();
    const fecha       = String(req.body.fecha       || '').trim();
    const horaInicio  = String(req.body.horaInicio  || '').trim();
    const horaFin     = String(req.body.horaFin     || '').trim();
    const equipo      = cleanTeam(req.body.equipo)  || ex[0].equipo;
    const color       = String(req.body.color || ex[0].color).trim();
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
          usuarios, creado_por, creado_en, debe, monto_deuda, vence, vence_hora, cover_image, checklist, pauta_url
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23)
        RETURNING *`,
        [
          cardId, data.nf, data.rs, data.cuit, data.ca, data.ntel, data.t, data.ta, data.c,
          data.color, data.estado, data.equipo, data.usuario, JSON.stringify(data.usuarios), req.user.id, creadoEn,
          data.debe, data.montoDeuda, data.vence, data.venceHora, data.coverImage, JSON.stringify(data.checklist), data.pautaUrl,
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
      res.status(201).json({ card: cardDTO(rows[0], history) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
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
    const ids    = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
    if (!equipo) return res.status(400).json({ error: 'Equipo invalido.' });
    if (!['iniciada','en_proceso','finalizado'].includes(estado)) return res.status(400).json({ error: 'Estado invalido.' });
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
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
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
        vence_hora=$17, cover_image=$18, checklist=$19::jsonb, pauta_url=$20, updated_at=NOW()
       WHERE id=$21
       RETURNING *`,
      [
        data.nf, data.rs, data.cuit, data.ca, data.ntel, data.t, data.ta, data.c, data.color,
        data.estado, data.equipo, data.usuario, JSON.stringify(data.usuarios), data.debe, data.montoDeuda, data.vence,
        data.venceHora, data.coverImage, JSON.stringify(data.checklist), data.pautaUrl, req.params.id,
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
    res.json({ card: cardDTO(rows[0], historyByCard.get(req.params.id) || []) });
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

    const today  = todayInArgentina();
    const wasOn  = String(cur[0].daily_check_date || '') === today;
    const newVal = wasOn ? '' : today;

    await pool.query(
      'UPDATE cards SET daily_check_date = $1, updated_at = NOW() WHERE id = $2',
      [newVal, req.params.id]
    );
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
    await pool.query(
      `UPDATE cards SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
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
    res.json({ card: cardDTO(rows[0], historyByCard.get(req.params.id) || []) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
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

async function start() {
  try {
    await ensureDatabaseMigrations();
    app.listen(PORT, () => {
      console.log(`ConsultoriaDigital en http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('No se pudo preparar la base de datos:', err);
    process.exit(1);
  }
}

start();
