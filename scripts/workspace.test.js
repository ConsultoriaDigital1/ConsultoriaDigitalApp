const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { register, validate, encrypt, decrypt } = require('../workspace');

process.env.CREDENTIALS_SECRET = 'test-only-credentials-key-with-enough-entropy';
const cards = [{ id: 'm1', equipo: 'marketing' }, { id: 'd1', equipo: 'desarrollo' }];
const entries = [];
const pool = { async query(sql, values) {
  if (sql.startsWith('SELECT * FROM cards')) return { rows: cards.filter(c => c.id === values[0]) };
  if (sql.startsWith('INSERT')) {
    const row = { id: values[0], card_id: values[1], kind: values[2], data: JSON.parse(values[3]) };
    entries.push(row);
    return { rows: [row] };
  }
  if (sql.startsWith('UPDATE')) {
    const row = entries.find(e => e.id === values[2]);
    row.data = JSON.parse(values[0]);
    return { rows: [row] };
  }
  if (sql.startsWith('DELETE')) { entries.splice(entries.findIndex(e => e.id === values[0]), 1); return { rows: [] }; }
  const rows = entries.map(e => ({ ...e, equipo: cards.find(c => c.id === e.card_id).equipo }));
  return { rows: rows.filter(e => sql.includes('WHERE e.kind') ? e.kind === values[0] : e.id === values[0]) };
} };
let server, base;
before(async () => {
  const app = express();
  app.use(express.json());
  register(app, pool, (req, res, next) => {
    const equipo = req.get('x-test-team');
    if (!equipo) return res.sendStatus(401);
    req.user = { id: 'test', equipo }; next();
  }, (user, team) => user.equipo === 'admin' || user.equipo === team);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => server.close());
async function request(path, team, method = 'GET', body) {
  const response = await fetch(base + '/api/workspace/' + path, { method, headers: { 'Content-Type': 'application/json', ...(team ? { 'x-test-team': team } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => ({})), headers: response.headers };
}

test('valida fechas reales, períodos, canales y URLs seguras', () => {
  assert.throws(() => validate('cronograma', { title: 'Post', date: '2026-02-30', status: 'programado' }), /Fecha/);
  assert.throws(() => validate('estadisticas', { channel: 'redes', start: '2026-11-02', end: '2026-11-01' }), /período/);
  assert.throws(() => validate('credenciales', { platform: 'Mail', username: 'a', url: 'javascript:alert(1)' }), /URL/);
  assert.throws(() => validate('estadisticas', { channel: 'otro' }), /Canal/);
  for (const status of ['programado', 'publicado', 'cancelado']) assert.equal(validate('cronograma', { title: 'Post', date: '2026-11-02', status }).status, status);
  for (const status of ['pendiente', 'en_proceso', 'completado']) assert.throws(() => validate('cronograma', { title: 'Post', date: '2026-11-02', status }), /Estado/);
});

test('cifra con IV aleatorio, detecta alteraciones y rechaza una clave débil', () => {
  const value = encrypt('secreto de prueba');
  assert.equal(decrypt(value), 'secreto de prueba');
  assert.notEqual(encrypt('secreto de prueba'), value);
  const parts = value.split('.'); parts[2] = Buffer.from('alterado').toString('base64');
  assert.throws(() => decrypt(parts.join('.')));
  const original = process.env.CREDENTIALS_SECRET;
  try { process.env.CREDENTIALS_SECRET = 'corta'; assert.throws(() => encrypt('x'), /CREDENTIALS_SECRET/); }
  finally { process.env.CREDENTIALS_SECRET = original; }
});

test('CRUD de credenciales protege contraseñas y aísla equipos', async () => {
  assert.equal((await request('credenciales')).status, 401);
  const data = { platform: 'Instagram', username: 'cliente', password: 'clave-prueba', url: 'https://instagram.com' };
  assert.equal((await request('credenciales', 'desarrollo', 'POST', { cardId: 'm1', data })).status, 403);
  const created = await request('credenciales', 'marketing', 'POST', { cardId: 'm1', data });
  assert.equal(created.status, 201);
  const id = created.body.entry.id;
  assert.equal(created.body.entry.data.password, undefined);
  assert.equal(created.body.entry.data.hasPassword, true);
  assert.notEqual(entries.find(e => e.id === id).data.password, data.password);
  assert.equal((await request('credenciales', 'desarrollo')).body.entries.length, 0);
  assert.equal((await request('credenciales', 'admin')).body.entries.length, 1);
  assert.equal((await request(`entries/${id}/reveal`, 'desarrollo', 'POST')).status, 404);
  const reveal = await request(`entries/${id}/reveal`, 'marketing', 'POST');
  assert.equal(reveal.body.password, data.password);
  assert.equal(reveal.headers.get('cache-control'), 'no-store');
  assert.equal((await request(`entries/${id}`, 'marketing', 'PUT', { data: { ...data, password: '', username: 'nuevo' } })).status, 200);
  assert.equal((await request(`entries/${id}/reveal`, 'marketing', 'POST')).body.password, data.password);
  assert.equal((await request(`entries/${id}`, 'desarrollo', 'DELETE')).status, 404);
  assert.equal((await request(`entries/${id}`, 'marketing', 'DELETE')).status, 200);
  assert.equal((await request(`entries/${id}/reveal`, 'marketing', 'POST')).status, 404);
  assert.equal((await request('credenciales', 'desarrollo', 'POST', { cardId: 'd1', data })).status, 201);
});

test('cronograma y reportes se guardan solo para Marketing; varios canales por cliente', async () => {
  const task = { title: 'Publicar reel', date: '2026-11-02', status: 'programado', owner: 'Eliana' };
  assert.equal((await request('cronograma', 'desarrollo', 'POST', { cardId: 'd1', data: task })).status, 403);
  const created = await request('cronograma', 'marketing', 'POST', { cardId: 'm1', data: task });
  assert.equal(created.status, 201);
  const id = created.body.entry.id;
  assert.equal((await request(`entries/${id}`, 'marketing', 'PUT', { data: { ...task, status: 'publicado' } })).body.entry.data.status, 'publicado');
  for (const channel of ['redes', 'pauta', 'web', 'whatsapp']) {
    assert.equal((await request('estadisticas', 'marketing', 'POST', { cardId: 'm1', data: { channel, start: '2026-11-01', end: '2026-11-30', metrics: [{ label: 'Consultas', value: '40' }] } })).status, 201);
  }
  assert.equal((await request('estadisticas', 'marketing')).body.entries.length, 4);
  assert.equal((await request('estadisticas', 'desarrollo')).body.entries.length, 0);
});
