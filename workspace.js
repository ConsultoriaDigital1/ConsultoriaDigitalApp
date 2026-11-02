const crypto = require('crypto');

const schema = `CREATE TABLE IF NOT EXISTS workspace_entries (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('cronograma', 'estadisticas', 'credenciales')),
  data JSONB NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workspace_entries_card ON workspace_entries(card_id, kind);
UPDATE workspace_entries
SET data = jsonb_set(data, '{status}', to_jsonb(CASE data->>'status'
  WHEN 'completado' THEN 'publicado' ELSE 'programado' END)), updated_at = NOW()
WHERE kind = 'cronograma' AND data->>'status' IN ('pendiente', 'en_proceso', 'completado');`;

function secretKey() {
  const secret = process.env.CREDENTIALS_SECRET || process.env.SESSION_SECRET;
  if (!secret || secret.length < 24 || /^(change-me|dev-only)/.test(secret)) {
    const err = new Error('Configurá CREDENTIALS_SECRET con al menos 24 caracteres para guardar accesos.');
    err.status = 503;
    throw err;
  }
  return crypto.scryptSync(secret, 'consultoria-credentials-v1', 32);
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(b => b.toString('base64')).join('.');
}

function decrypt(value) {
  const [iv, tag, body] = value.split('.').map(s => Buffer.from(s, 'base64'));
  const cipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(body), cipher.final()]).toString('utf8');
}

function validate(kind, input) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  const text = (name, limit = 2000) => {
    if (input[name] != null && typeof input[name] !== 'string') fail('Campo inválido: ' + name);
    const value = (input[name] || '').trim();
    if (value.length > limit) fail('Campo demasiado largo: ' + name);
    return value;
  };
  const required = name => { const value = text(name); if (!value) fail('Completá ' + name); return value; };
  const date = name => {
    const value = required(name);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('Fecha inválida.');
    return value;
  };
  if (kind === 'cronograma') {
    const status = text('status');
    if (!['programado', 'publicado', 'cancelado'].includes(status)) fail('Estado inválido.');
    return { title: required('title'), date: date('date'), owner: text('owner', 200), status, notes: text('notes') };
  }
  if (kind === 'estadisticas') {
    const channel = text('channel');
    if (!['redes', 'pauta', 'web', 'whatsapp'].includes(channel)) fail('Canal inválido.');
    const start = date('start'), end = date('end');
    if (end < start) fail('El fin del período debe ser posterior al inicio.');
    if (!Array.isArray(input.metrics) || !input.metrics.length || input.metrics.length > 20) fail('Agregá entre 1 y 20 métricas.');
    const metrics = input.metrics.map(m => {
      if (!m || typeof m.label !== 'string' || !m.label.trim() || m.label.length > 120 || typeof m.value !== 'string' || !m.value.trim() || m.value.length > 120) fail('Métrica inválida.');
      return { label: m.label.trim(), value: m.value.trim() };
    });
    return { channel, start, end, metrics, notes: text('notes', 8000) };
  }
  if (kind === 'credenciales') {
    const url = text('url');
    if (url) { try { if (!['https:', 'http:'].includes(new URL(url).protocol)) fail('URL inválida.'); } catch (_) { fail('Usá una URL http o https válida.'); } }
    return { platform: required('platform'), username: required('username'), url, notes: text('notes'), password: text('password', 4000) };
  }
  fail('Sección inválida.');
}

function register(app, pool, requireAuth, canAccessTeam) {
  function permitted(user, team, kind) {
    return canAccessTeam(user, team) && (kind === 'credenciales' ? ['marketing', 'desarrollo'].includes(team) : team === 'marketing');
  }
  function dto(row) {
    const data = { ...row.data };
    if (row.kind === 'credenciales') { data.hasPassword = !!data.password; delete data.password; }
    return { id: row.id, cardId: row.card_id, kind: row.kind, data, updatedAt: row.updated_at };
  }
  app.get('/api/workspace/:kind', requireAuth, async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const { kind } = req.params;
      if (!['cronograma', 'estadisticas', 'credenciales'].includes(kind)) return res.status(400).json({ error: 'Sección inválida.' });
      const { rows } = await pool.query(`SELECT e.*, c.equipo FROM workspace_entries e JOIN cards c ON c.id = e.card_id WHERE e.kind = $1 AND c.deleted_at IS NULL ORDER BY e.updated_at DESC`, [kind]);
      res.json({ entries: rows.filter(r => permitted(req.user, r.equipo, kind)).map(dto) });
    } catch (err) { next(err); }
  });
  app.post('/api/workspace/:kind', requireAuth, async (req, res, next) => {
    try {
      const { kind } = req.params;
      const data = validate(kind, req.body.data || {});
      const { rows } = await pool.query('SELECT * FROM cards WHERE id = $1 AND deleted_at IS NULL', [req.body.cardId]);
      if (!rows[0] || !permitted(req.user, rows[0].equipo, kind)) return res.status(403).json({ error: 'Cliente no disponible para tu equipo.' });
      if (kind === 'credenciales') {
        if (!data.password) return res.status(400).json({ error: 'Completá la contraseña.' });
        data.password = encrypt(data.password);
      }
      const result = await pool.query('INSERT INTO workspace_entries (id, card_id, kind, data, updated_by) VALUES ($1, $2, $3, $4, $5) RETURNING *', [crypto.randomUUID(), req.body.cardId, kind, JSON.stringify(data), req.user.id]);
      res.status(201).json({ entry: dto(result.rows[0]) });
    } catch (err) { next(err); }
  });
  async function accessible(req) {
    const { rows } = await pool.query('SELECT e.*, c.equipo, c.deleted_at FROM workspace_entries e JOIN cards c ON c.id = e.card_id WHERE e.id = $1', [req.params.id]);
    const row = rows[0];
    return row && !row.deleted_at && permitted(req.user, row.equipo, row.kind) ? row : null;
  }
  app.put('/api/workspace/entries/:id', requireAuth, async (req, res, next) => {
    try {
      const row = await accessible(req);
      if (!row) return res.status(404).json({ error: 'Registro no disponible.' });
      const data = validate(row.kind, req.body.data || {});
      if (row.kind === 'credenciales') data.password = data.password ? encrypt(data.password) : row.data.password;
      const result = await pool.query('UPDATE workspace_entries SET data = $1, updated_by = $2, updated_at = NOW() WHERE id = $3 RETURNING *', [JSON.stringify(data), req.user.id, row.id]);
      res.json({ entry: dto(result.rows[0]) });
    } catch (err) { next(err); }
  });
  app.post('/api/workspace/entries/:id/reveal', requireAuth, async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const row = await accessible(req);
      if (!row || row.kind !== 'credenciales') return res.status(404).json({ error: 'Acceso no disponible.' });
      res.json({ password: decrypt(row.data.password) });
    } catch (err) { next(err); }
  });
  app.delete('/api/workspace/entries/:id', requireAuth, async (req, res, next) => {
    try {
      const row = await accessible(req);
      if (!row) return res.status(404).json({ error: 'Registro no disponible.' });
      await pool.query('DELETE FROM workspace_entries WHERE id = $1', [row.id]);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });
}

module.exports = { schema, register, validate, encrypt, decrypt };
