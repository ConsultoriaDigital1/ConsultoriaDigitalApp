const fs = require('fs');
const path = require('path');

const schema = fs.readFileSync(path.join(__dirname, 'db/card-audit.sql'), 'utf8');
const ACTIONS = ['create', 'move', 'edit', 'trash', 'restore', 'delete', 'reorder', 'comment'];

async function setActor(client, user, source = 'user') {
  const actor = user
    ? { id: user.id, name: [user.nombre, user.apellido].filter(Boolean).join(' '), username: user.username, source }
    : { id: null, name: source === 'automation' ? 'Automatización' : 'Sistema', username: '', source };
  await client.query("SELECT set_config('app.card_audit_actor', $1, true)", [JSON.stringify(actor)]);
}

async function withActor(pool, user, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setActor(client, user);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

function auditQuery(user, query) {
  const teams = user.equipo === 'admin' ? ['marketing', 'desarrollo', 'admin', 'ventas'] : [user.equipo];
  if (query.team && query.team !== 'all') {
    if (!teams.includes(query.team)) throw Object.assign(new Error('Sin permiso para ese equipo.'), { status: 403 });
    teams.splice(0, teams.length, query.team);
  }
  const params = [teams];
  const conditions = ['teams && $1::text[]'];
  const add = (sql, value) => { params.push(value); conditions.push(sql.replace('?', '$' + params.length)); };
  const resource = query.resource || 'card';
  if (!['card', 'estadisticas'].includes(resource)) throw Object.assign(new Error('Historial inválido.'), { status: 400 });
  add('resource = ?', resource);
  if (query.cursor) {
    if (!/^\d{1,18}$/.test(String(query.cursor))) throw Object.assign(new Error('Página inválida.'), { status: 400 });
    add('id < ?::bigint', query.cursor);
  }
  if (query.cardId) add('card_id = ?', String(query.cardId).slice(0, 200));
  if (query.action) {
    if (!ACTIONS.includes(query.action)) throw Object.assign(new Error('Acción inválida.'), { status: 400 });
    add('action = ?', query.action);
  }
  const search = String(query.q || '').trim().slice(0, 200);
  if (search) {
    params.push('%' + search.replace(/[\\%_]/g, '\\$&') + '%');
    conditions.push(`(card_name ILIKE $${params.length} OR actor->>'name' ILIKE $${params.length} OR actor->>'username' ILIKE $${params.length})`);
  }
  return { text: `SELECT * FROM card_audit_log WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT 51`, values: params };
}

function register(app, pool, requireAuth) {
  app.get('/api/card-audit', requireAuth, async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const query = auditQuery(req.user, req.query);
      const { rows } = await pool.query(query.text, query.values);
      res.json({ entries: rows.slice(0, 50).map(row => ({ id: row.id, cardId: row.card_id, cardName: row.card_name, resource: row.resource, recordId: row.record_id, action: row.action, actor: row.actor, changes: row.changes, occurredAt: row.occurred_at })), nextCursor: rows.length > 50 ? rows[49].id : null });
    } catch (err) { next(err); }
  });
}

module.exports = { schema, setActor, withActor, auditQuery, register };
