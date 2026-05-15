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
  };
}

function cardDTO(row) {
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
    usuario: row.usuario,
    creadoPor: row.creado_por,
    creadoEn: Number(row.creado_en),
    debe: row.debe,
    montoDeuda: row.monto_deuda,
    vence: row.vence,
    coverImage: row.cover_image,
  };
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

async function visibleUsers(user) {
  const teams = allowedTeams(user);
  const { rows } = await pool.query(
    'SELECT id, username, nombre, apellido, equipo FROM users WHERE equipo = ANY($1) ORDER BY nombre, apellido',
    [teams]
  );
  return rows.map(userDTO);
}

async function visibleCards(user) {
  const teams = allowedTeams(user);
  const { rows } = await pool.query(
    'SELECT * FROM cards WHERE equipo = ANY($1) ORDER BY creado_en DESC',
    [teams]
  );
  return rows.map(cardDTO);
}

async function visibleCalendars(user) {
  const teams = allowedTeams(user);
  return Object.fromEntries(teams.map((team) => [team, calendarUrlFromEnv(team)]));
}

function cleanUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function cleanTeam(value) {
  return ['marketing', 'desarrollo', 'admin'].includes(value) ? value : '';
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

function cardValues(body, user, existing = {}) {
  const equipo = cleanTeam(body.equipo || existing.equipo || user.equipo);
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
    usuario: body.usuario || null,
    debe: body.debe === 'si' ? 'si' : 'no',
    montoDeuda: String(body.montoDeuda || ''),
    vence: String(body.vence || ''),
    coverImage: String(body.coverImage || ''),
  };
}

async function validateAssignedUser(user, assignedId, team) {
  if (!assignedId) return null;
  const assigned = await getUserById(assignedId);
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
  return assigned.id;
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
    res.json({
      user: userDTO(req.user),
      users: await visibleUsers(req.user),
      cards: await visibleCards(req.user),
      calendars: await visibleCalendars(req.user),
      teams: allowedTeams(req.user),
    });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/profile', requireAuth, async (req, res, next) => {
  try {
    const nombre = String(req.body.nombre || '').trim();
    const apellido = String(req.body.apellido || '').trim();
    const password = String(req.body.password || '');
    if (!nombre) return res.status(400).json({ error: 'El nombre no puede estar vacio.' });

    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Contrasena minimo 6 caracteres.' });
      const passwordHash = await bcrypt.hash(password, 12);
      await pool.query(
        'UPDATE users SET nombre = $1, apellido = $2, password_hash = $3, updated_at = NOW() WHERE id = $4',
        [nombre, apellido, passwordHash, req.user.id]
      );
    } else {
      await pool.query(
        'UPDATE users SET nombre = $1, apellido = $2, updated_at = NOW() WHERE id = $3',
        [nombre, apellido, req.user.id]
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

app.post('/api/cards', requireAuth, async (req, res, next) => {
  try {
    const data = cardValues(req.body, req.user);
    validateCardRequired(data);
    data.usuario = await validateAssignedUser(req.user, data.usuario, data.equipo);
    const { rows } = await pool.query(
      `INSERT INTO cards (
        id, nf, rs, cuit, ca, ntel, t, ta, c, color, estado, equipo, usuario,
        creado_por, creado_en, debe, monto_deuda, vence, cover_image
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING *`,
      [
        mkId(), data.nf, data.rs, data.cuit, data.ca, data.ntel, data.t, data.ta, data.c,
        data.color, data.estado, data.equipo, data.usuario, req.user.id, Date.now(),
        data.debe, data.montoDeuda, data.vence, data.coverImage,
      ]
    );
    res.status(201).json({ card: cardDTO(rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.put('/api/cards/:id', requireAuth, async (req, res, next) => {
  try {
    const current = await pool.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
    if (!current.rows[0]) return res.status(404).json({ error: 'Tarjeta no encontrada.' });
    if (!canAccessTeam(req.user, current.rows[0].equipo)) return res.status(403).json({ error: 'Sin permiso.' });
    const data = cardValues(req.body, req.user, current.rows[0]);
    validateCardRequired(data);
    data.usuario = await validateAssignedUser(req.user, data.usuario, data.equipo);
    const { rows } = await pool.query(
      `UPDATE cards SET
        nf=$1, rs=$2, cuit=$3, ca=$4, ntel=$5, t=$6, ta=$7, c=$8, color=$9,
        estado=$10, equipo=$11, usuario=$12, debe=$13, monto_deuda=$14, vence=$15,
        cover_image=$16, updated_at=NOW()
       WHERE id=$17
       RETURNING *`,
      [
        data.nf, data.rs, data.cuit, data.ca, data.ntel, data.t, data.ta, data.c, data.color,
        data.estado, data.equipo, data.usuario, data.debe, data.montoDeuda, data.vence,
        data.coverImage, req.params.id,
      ]
    );
    res.json({ card: cardDTO(rows[0]) });
  } catch (err) {
    next(err);
  }
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

app.delete('/api/cards/:id', requireAuth, async (req, res, next) => {
  try {
    const current = await pool.query('SELECT equipo FROM cards WHERE id = $1', [req.params.id]);
    if (!current.rows[0]) return res.status(404).json({ error: 'Tarjeta no encontrada.' });
    if (!canAccessTeam(req.user, current.rows[0].equipo)) return res.status(403).json({ error: 'Sin permiso.' });
    await pool.query('DELETE FROM cards WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Ruta API no encontrada.' });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Error interno.' });
});

app.listen(PORT, () => {
  console.log(`ConsultoriaDigital en http://localhost:${PORT}`);
});
