const { test } = require('node:test');
const assert = require('node:assert/strict');
const { auditQuery, withActor } = require('../card-audit');

test('trazabilidad limita equipos y rechaza filtros inválidos', () => {
  assert.deepEqual(auditQuery({ equipo: 'marketing' }, {}).values[0], ['marketing']);
  assert.deepEqual(auditQuery({ equipo: 'admin' }, {}).values[0], ['marketing', 'desarrollo', 'admin', 'ventas']);
  assert.throws(() => auditQuery({ equipo: 'marketing' }, { team: 'desarrollo' }), { status: 403 });
  assert.throws(() => auditQuery({ equipo: 'admin' }, { action: 'otro' }), { status: 400 });
  assert.throws(() => auditQuery({ equipo: 'admin' }, { cursor: '1 OR 1=1' }), { status: 400 });
  assert.throws(() => auditQuery({ equipo: 'admin' }, { cursor: '99999999999999999999' }), { status: 400 });
  assert.throws(() => auditQuery({ equipo: 'admin' }, { resource: 'credenciales' }), { status: 400 });
  assert.equal(auditQuery({ equipo: 'marketing' }, { resource: 'estadisticas', cardId: 'c1' }).values[1], 'estadisticas');
});

test('búsqueda parametrizada y paginación estable', () => {
  const result = auditQuery({ equipo: 'admin' }, { team: 'marketing', cursor: '84', action: 'move', q: "50%_O'Reilly" });
  assert.match(result.text, /ORDER BY id DESC LIMIT 51/);
  assert.ok(!result.text.includes("O'Reilly"));
  assert.deepEqual(result.values, [['marketing'], 'card', '84', 'move', "%50\\%\\_O'Reilly%"]);
});

test('usuario y cambio comparten transacción; los errores revierten todo', async () => {
  for (const shouldFail of [false, true]) {
    const calls = [];
    const client = { query: async (sql, values) => { calls.push({ sql, values }); }, release: () => calls.push({ sql: 'release' }) };
    const operation = withActor({ connect: async () => client }, { id: 'u1', nombre: 'Eliana', apellido: 'Prueba', username: 'eliana' }, async c => {
      await c.query('UPDATE cards SET estado = $1', ['en_proceso']);
      if (shouldFail) throw new Error('fallo');
      return 'guardado';
    });
    if (shouldFail) await assert.rejects(operation, /fallo/); else assert.equal(await operation, 'guardado');
    assert.deepEqual(calls.map(c => c.sql), ['BEGIN', "SELECT set_config('app.card_audit_actor', $1, true)", 'UPDATE cards SET estado = $1', shouldFail ? 'ROLLBACK' : 'COMMIT', 'release']);
    assert.deepEqual(JSON.parse(calls[1].values[0]), { id: 'u1', name: 'Eliana Prueba', username: 'eliana', source: 'user' });
  }
});
