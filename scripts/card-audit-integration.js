// Ejecuta pruebas con PostgreSQL real en un esquema aislado; siempre hace ROLLBACK.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const audit = require('../card-audit');
const pool = new Pool({ connectionString: process.env.AUDIT_TEST_DATABASE_URL || process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false });

async function main() {
  const db = await pool.connect();
  const namespace = 'audit_test_' + crypto.randomBytes(6).toString('hex');
  try {
    await db.query('BEGIN');
    await db.query(`CREATE SCHEMA ${namespace}`);
    await db.query(`SET LOCAL search_path TO ${namespace}, public`);
    for (const name of ['users', 'cards', 'card_description_history']) await db.query(`CREATE TABLE ${name} (LIKE public.${name} INCLUDING DEFAULTS)`);
    await db.query(audit.schema);
    await audit.setActor(db, { id: 'audit-user', nombre: 'Eliana', apellido: 'Prueba', username: 'eliana' });
    await db.query("INSERT INTO users (id, username, nombre, password_hash, equipo) VALUES ('audit-user', 'eliana', 'Eliana', 'NO_LOGIN', 'marketing')");
    await db.query("INSERT INTO cards (id,nf,equipo,estado,creado_en) VALUES ('audit-card','Cliente 50%_literal','marketing','iniciada',1)");
    await db.query("UPDATE cards SET estado='en_proceso', c='Nueva descripción' WHERE id='audit-card'");
    await db.query("UPDATE cards SET position=3 WHERE id='audit-card'");
    await db.query("UPDATE cards SET checklist=$1, cover_image=$2, attachments=$3 WHERE id='audit-card'", [JSON.stringify([{ id: 'task', text: 'Publicar reel', done: true, usuario: 'audit-user' }]), 'PRIVATE_BINARY_COVER', JSON.stringify([{ id: 'file', name: 'reporte.pdf', type: 'application/pdf', size: 12, data: 'PRIVATE_BINARY_FILE' }])]);
    await db.query("INSERT INTO card_description_history (id,card_id,user_id,description,kind,creado_en) VALUES ('comment','audit-card','audit-user','Comentario de prueba','comentario',1)");
    const count = async () => Number((await db.query('SELECT count(*) AS n FROM card_audit_log')).rows[0].n);
    const before = await count();
    await db.query("UPDATE cards SET updated_at=NOW() WHERE id='audit-card'");
    assert.equal(await count(), before, 'no registra guardados sin cambios');
    await db.query('SAVEPOINT failed_edit');
    await db.query("UPDATE cards SET nf='Edición revertida' WHERE id='audit-card'");
    assert.equal(await count(), before + 1);
    await db.query('ROLLBACK TO SAVEPOINT failed_edit');
    assert.equal(await count(), before, 'el registro revierte junto con el cambio');
    await db.query("UPDATE cards SET deleted_at=NOW() WHERE id='audit-card'");
    await db.query("UPDATE cards SET deleted_at=NULL WHERE id='audit-card'");
    await audit.setActor(db, null, 'automation');
    await db.query("UPDATE cards SET equipo='desarrollo' WHERE id='audit-card'");
    await db.query("SELECT set_config('app.card_audit_actor', '', true)");
    await db.query("UPDATE cards SET nf='Cambio del sistema' WHERE id='audit-card'");
    await audit.setActor(db, { id: 'audit-user', nombre: 'Eliana', apellido: 'Prueba', username: 'eliana' });
    await db.query("DELETE FROM cards WHERE id='audit-card'");
    await db.query("DELETE FROM users WHERE id='audit-user'");
    const { rows } = await db.query('SELECT * FROM card_audit_log ORDER BY id');
    assert.deepEqual(rows.map(r => r.action), ['create', 'move', 'reorder', 'edit', 'comment', 'trash', 'restore', 'move', 'edit', 'delete']);
    assert.equal(rows[0].actor.name, 'Eliana Prueba');
    assert.equal(rows[1].changes.estado.before, 'iniciada');
    assert.equal(rows[1].changes.estado.after, 'en_proceso');
    assert.equal(rows[3].changes.checklist.after[0].done, true);
    assert.equal(rows[4].changes.comentario.after, 'Comentario de prueba');
    assert.equal(rows[7].actor.name, 'Automatización');
    assert.equal(rows[8].actor.name, 'Sistema');
    assert.equal(rows[9].actor.name, 'Eliana Prueba', 'sobrevive al usuario eliminado');
    assert.ok(!JSON.stringify(rows).includes('PRIVATE_BINARY'), 'no guarda archivos ni imágenes en base64');
    const scoped = audit.auditQuery({ equipo: 'marketing' }, {});
    const marketing = await db.query(scoped.text, scoped.values);
    assert.ok(!marketing.rows.some(r => r.action === 'delete'), 'no expone cambios posteriores de otro equipo');
    assert.ok(marketing.rows.some(r => r.action === 'move' && r.teams.includes('desarrollo')), 'registra la transferencia de equipo');
    const literal = audit.auditQuery({ equipo: 'admin' }, { q: '50%_literal', action: 'create' });
    assert.equal((await db.query(literal.text, literal.values)).rows.length, 1);
    console.log('PostgreSQL: creación, movimientos, edición, checklist, comentarios, papelera, restauración, eliminación, permisos y rollback verificados.');
  } finally {
    await db.query('ROLLBACK').catch(() => {});
    db.release();
    await pool.end();
  }
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
