const { test } = require('node:test');
const assert = require('node:assert/strict');
const analisis = require('../analisis');
const { construirPdf, armarIndicadores, periodoTexto } = require('../analisis-pdf');

const meses = analisis.mesesEntre('2026-06', '2026-10');
const serie = valores => Object.fromEntries(meses.map((m, i) => [m, { valor: valores[i], origen: 'receta' }]));
// Los números reales de Unimed de junio a octubre de 2026 (los del PDF de casos de éxito).
const unimed = {
  nombre: 'Unimed', categoria: 'turneria', descripcion: '',
  metricas: {
    turnos_total: serie([1346, 1449, 1406, 1455, 1432]), turnos_bot: serie([553, 838, 876, 918, 921]),
    recordatorios: serie([445, 790, 819, 870, 866]), asistencias: serie([0, 429, 644, 702, 696]),
    conversaciones: serie([1323, 1794, 1958, 2333, 2407]), conv_bot: serie([1182, 1632, 1735, 2126, 2210]),
  },
};

test('meses y períodos', () => {
  assert.deepEqual(analisis.mesesEntre('2026-11', '2027-02'), ['2026-11', '2026-12', '2027-01', '2027-02']);
  assert.equal(analisis.sumarMes('2026-01', -1), '2025-12');
  assert.equal(periodoTexto('2026-06', '2026-10'), 'junio a octubre de 2026');
  assert.equal(periodoTexto('2025-11', '2026-02'), 'noviembre de 2025 a febrero de 2026');
});

test('la configuración solo acepta categorías, recetas y workflows válidos', () => {
  const ok = analisis.validarConfig({ categoria: 'turneria', fuentes: [{ tipo: 'receta', receta: 'turneria-unimed' }, { tipo: 'n8n', workflows: ['9KkBkq4XxxlswI7D', '9KkBkq4XxxlswI7D'] }] });
  assert.equal(ok.categoria, 'turneria');
  assert.deepEqual(ok.fuentes[1].workflows, ['9KkBkq4XxxlswI7D']);
  assert.equal(analisis.validarConfig({ categoria: '' }).categoria, null);
  assert.throws(() => analisis.validarConfig({ categoria: 'otra' }), /Categoría inválida/);
  assert.throws(() => analisis.validarConfig({ fuentes: [{ tipo: 'receta', receta: 'SELECT 1' }] }), /Receta desconocida/);
  assert.throws(() => analisis.validarConfig({ fuentes: [{ tipo: 'n8n', workflows: ["x'; DROP"] }] }), /workflows/);
  assert.throws(() => analisis.validarConfig({ fuentes: [{ tipo: 'sql', consulta: 'x' }] }), /Tipo de fuente/);
});

test('la carga manual valida mes y números', () => {
  assert.deepEqual(analisis.validarManual({ mes: '2026-10', valores: { visitas: '3200', usuarios: '' } }), { mes: '2026-10', valores: { visitas: 3200, usuarios: null } });
  assert.throws(() => analisis.validarManual({ mes: '2026-13', valores: { visitas: '1' } }), /Mes inválido/);
  assert.throws(() => analisis.validarManual({ mes: '2026-10', valores: { inventada: '1' } }), /Métrica desconocida/);
  assert.throws(() => analisis.validarManual({ mes: '2026-10', valores: { visitas: '-4' } }), /Valor inválido/);
});

test('las recetas son solo de lectura: ninguna consulta escribe', () => {
  for (const receta of Object.values(analisis.RECETAS)) {
    for (const sql of receta.consultas) assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/i);
    assert.match(receta.env, /^ANALISIS_DB_[A-Z_]+$/);
  }
});

test('el conteo de n8n pagina y se frena al llegar al día ya contado', async () => {
  const dia = d => new Date(Date.UTC(2026, 10, d, 15)).toISOString(); // 12:00 en Argentina
  const ejecuciones = [];
  for (let d = 10; d >= 1; d--) for (let i = 0; i < 30; i++) ejecuciones.push({ startedAt: dia(d), status: i === 0 ? 'error' : i === 1 ? 'canceled' : 'success' });
  let pedidos = 0;
  const fetchViejo = global.fetch;
  process.env.N8N_API_KEY = 'prueba';
  global.fetch = async url => {
    pedidos++;
    const u = new URL(url);
    const desde = Number(u.searchParams.get('cursor') || 0);
    const pagina = ejecuciones.slice(desde, desde + 250);
    return { ok: true, json: async () => ({ data: pagina, nextCursor: desde + 250 < ejecuciones.length ? String(desde + 250) : null }) };
  };
  try {
    const todo = await analisis.contarEjecuciones('wf123456', '');
    assert.equal(Object.keys(todo.dias).length, 10);
    assert.deepEqual(todo.dias['2026-11-05'], { ok: 28, error: 1 });
    assert.equal(pedidos, 2);
    pedidos = 0;
    const reciente = await analisis.contarEjecuciones('wf123456', '2026-11-09');
    assert.deepEqual(Object.keys(reciente.dias).sort(), ['2026-11-09', '2026-11-10']);
    assert.equal(pedidos, 1, 'no tiene que seguir pidiendo páginas viejas');
  } finally {
    global.fetch = fetchViejo;
    delete process.env.N8N_API_KEY;
  }
});

test('los números del informe cuadran con el caso de Unimed', () => {
  const { kpis, graficos } = armarIndicadores(unimed, meses);
  assert.equal(kpis[0].valor, '4.106');
  assert.equal(kpis[1].valor, '91 %');
  assert.equal(kpis[2].valor, '8 de 10');
  assert.match(kpis[2].texto, /octubre/);
  assert.equal(kpis[3].valor, '64 %');
  assert.equal(graficos.length, 3);
  assert.equal(graficos[0].titulo, 'En octubre, el bot dio 2 de cada 3 turnos');
  assert.deepEqual(graficos[0].series[1].valores, [793, 611, 530, 537, 511]);
});

test('el PDF sale, con o sin números', async () => {
  const base = { desde: '2026-06', hasta: '2026-10', meses, categorias: analisis.CATEGORIAS, metricas: analisis.METRICAS, notas: [], analisis: 'Próximo paso: ampliar.' };
  const lleno = await construirPdf({ ...base, cliente: unimed });
  assert.equal(lleno.subarray(0, 5).toString(), '%PDF-');
  const vacio = await construirPdf({ ...base, cliente: { nombre: 'Sin datos', categoria: null, metricas: {} } });
  assert.equal(vacio.subarray(0, 5).toString(), '%PDF-');
});
