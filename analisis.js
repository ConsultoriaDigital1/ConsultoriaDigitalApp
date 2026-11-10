// Análisis: números de cada proyecto (bots, turnerías, sistemas) por cliente y por
// categoría, para que la dirección los vea en vivo y genere el PDF para el cliente.
//
// De dónde salen los números:
//  - n8n: ejecuciones por día de los workflows del cliente (mensajes que atendió el bot
//    y ejecuciones con error). n8n borra ejecuciones viejas, así que cada día contado
//    se guarda acá y queda fijo: el historial se arma solo desde que se conecta.
//  - receta: consultas fijas, escritas en este archivo, contra la base del cliente.
//    La conexión sale de una variable de entorno (nunca de la pantalla ni de la base),
//    y la sesión se abre en solo lectura.
//  - manual: lo que se carga a mano por mes, para lo que no tiene de dónde leerse.
const fs = require('fs');
const { Pool } = require('pg');
const cardAudit = require('./card-audit');

const ZONA = 'America/Argentina/Buenos_Aires';

const CATEGORIAS = {
  turneria: 'Turnería',
  ventas: 'Bots de ventas y atención',
  cobranzas: 'Cobranzas y tesorería',
  gestion: 'Sistemas de gestión y webs',
};

// Catálogo de métricas. `suma` dice cómo se junta un período de varios meses.
const METRICAS = {
  turnos_total: { label: 'Turnos atendidos', corto: 'turnos atendidos en total' },
  turnos_bot: { label: 'Turnos dados por el bot', corto: 'turnos dados por el bot' },
  recordatorios: { label: 'Recordatorios enviados', corto: 'recordatorios enviados' },
  asistencias: { label: 'Asistencias confirmadas', corto: 'pacientes confirmaron que van' },
  conversaciones: { label: 'Conversaciones', corto: 'conversaciones atendidas' },
  conv_bot: { label: 'Resueltas por el bot', corto: 'conversaciones resueltas por el bot' },
  mensajes_bot: { label: 'Mensajes atendidos por el bot', corto: 'mensajes atendidos por el bot' },
  errores_bot: { label: 'Ejecuciones con error', corto: 'ejecuciones con error' },
  ventas: { label: 'Ventas cerradas', corto: 'ventas cerradas' },
  leads: { label: 'Contactos nuevos', corto: 'contactos nuevos' },
  cobros: { label: 'Comprobantes procesados', corto: 'comprobantes procesados' },
  usuarios: { label: 'Usuarios activos', corto: 'usuarios activos' },
  visitas: { label: 'Visitas', corto: 'visitas' },
};

// Recetas: consultas a la base de un cliente. Cada consulta devuelve filas
// { mes: 'YYYY-MM', <metrica>: número, ... } para los meses >= $1 (fecha).
const RECETAS = {
  'turneria-unimed': {
    label: 'TurnerIA Unimed (base de turnos)',
    env: 'ANALISIS_DB_UNIMED',
    nota: 'Turnos atendidos: estado FINALIZADO. El bot es el origen "web". Recordatorios: aviso 2 h antes. Conversaciones: un paciente por día; pasa a una persona cuando el bot deriva al secretario.',
    consultas: [
      `SELECT to_char(fecha, 'YYYY-MM') AS mes,
              count(*) FILTER (WHERE estado = 'FINALIZADO') AS turnos_total,
              count(*) FILTER (WHERE estado = 'FINALIZADO' AND origen = 'web') AS turnos_bot,
              count(aviso_2h_enviado_at) AS recordatorios,
              count(asistencia_confirmada_at) AS asistencias
         FROM horarios
        WHERE fecha >= $1::date AND fecha < (now() AT TIME ZONE '${ZONA}')::date + 1
        GROUP BY 1`,
      `WITH s AS (
         SELECT session_id,
                to_date(substring(session_id FROM '(\\d{1,2}-\\d{1,2}-\\d{4})$'), 'DD-MM-YYYY') AS dia,
                bool_or(message->>'type' = 'human') AS humano,
                bool_or(message->>'content' LIKE '%derivar_a_secretario%'
                     OR message->>'content' LIKE '%Handoff de%'
                     OR message->>'content' LIKE '%ya te va a atender el secretario%') AS derivada
           FROM n8n_chat_histories
          WHERE session_id ~ '\\d{1,2}-\\d{1,2}-\\d{4}$'
          GROUP BY 1)
       SELECT to_char(dia, 'YYYY-MM') AS mes,
              count(*) FILTER (WHERE humano) AS conversaciones,
              count(*) FILTER (WHERE humano AND NOT derivada) AS conv_bot
         FROM s
        WHERE dia >= $1::date
        GROUP BY 1`,
    ],
  },
};

const schema = `
CREATE TABLE IF NOT EXISTS analisis_config (
  card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  categoria TEXT CHECK (categoria IN ('turneria', 'ventas', 'cobranzas', 'gestion')),
  oculto BOOLEAN NOT NULL DEFAULT FALSE,
  fuentes JSONB NOT NULL DEFAULT '[]'::jsonb,
  descripcion TEXT NOT NULL DEFAULT '',
  desde TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS analisis_mensual (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  metrica TEXT NOT NULL,
  mes TEXT NOT NULL,
  origen TEXT NOT NULL CHECK (origen IN ('receta', 'manual')),
  valor NUMERIC NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (card_id, metrica, mes, origen)
);
CREATE TABLE IF NOT EXISTS analisis_diario (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  metrica TEXT NOT NULL,
  dia DATE NOT NULL,
  valor NUMERIC NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (card_id, metrica, dia)
);
CREATE TABLE IF NOT EXISTS analisis_estado (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  fuente TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  detalle TEXT NOT NULL DEFAULT '',
  revisado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (card_id, fuente)
);`;

const MES_RE = /^(20\d{2})-(0[1-9]|1[0-2])$/;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function hoyLocal(date = new Date()) {
  return date.toLocaleDateString('sv-SE', { timeZone: ZONA });
}

function mesesEntre(desde, hasta) {
  const out = [];
  let [y, m] = desde.split('-').map(Number);
  const [hy, hm] = hasta.split('-').map(Number);
  while (y < hy || (y === hy && m <= hm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 60) break;
  }
  return out;
}

function sumarMes(mes, delta) {
  const [y, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

// ── Validación de lo que llega de la pantalla ──
function validarConfig(input) {
  const categoria = input.categoria == null || input.categoria === '' ? null : String(input.categoria);
  if (categoria && !CATEGORIAS[categoria]) fail('Categoría inválida.');
  const fuentes = [];
  if (!Array.isArray(input.fuentes || [])) fail('Fuentes inválidas.');
  for (const f of input.fuentes || []) {
    if (!f || typeof f !== 'object') fail('Fuente inválida.');
    if (f.tipo === 'n8n') {
      const ids = Array.isArray(f.workflows) ? f.workflows.map(String) : [];
      if (!ids.length || ids.length > 20 || ids.some(id => !/^[A-Za-z0-9]{6,40}$/.test(id))) fail('Elegí entre 1 y 20 workflows de n8n.');
      fuentes.push({ tipo: 'n8n', workflows: [...new Set(ids)] });
    } else if (f.tipo === 'receta') {
      if (!RECETAS[f.receta]) fail('Receta desconocida.');
      fuentes.push({ tipo: 'receta', receta: f.receta });
    } else fail('Tipo de fuente inválido.');
  }
  const descripcion = typeof input.descripcion === 'string' ? input.descripcion.trim().slice(0, 300) : '';
  const desde = typeof input.desde === 'string' && MES_RE.test(input.desde) ? input.desde : '';
  return { categoria, oculto: !!input.oculto, fuentes, descripcion, desde };
}

function validarManual(input) {
  if (typeof input.mes !== 'string' || !MES_RE.test(input.mes)) fail('Mes inválido.');
  if (!input.valores || typeof input.valores !== 'object') fail('Cargá al menos un valor.');
  const valores = {};
  for (const [k, v] of Object.entries(input.valores)) {
    if (!METRICAS[k]) fail('Métrica desconocida: ' + k);
    if (v === '' || v == null) { valores[k] = null; continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1e12) fail('Valor inválido en ' + METRICAS[k].label + '.');
    valores[k] = Math.round(n);
  }
  return { mes: input.mes, valores };
}

// ── Lectura de n8n ──
function n8nConfig() {
  const base = (process.env.N8N_API_URL || 'http://127.0.0.1:5678/api/v1').replace(/\/$/, '');
  let key = process.env.N8N_API_KEY || '';
  if (!key && process.env.N8N_API_KEY_FILE) {
    try { key = fs.readFileSync(process.env.N8N_API_KEY_FILE, 'utf8').trim(); } catch (_) { key = ''; }
  }
  return { base, key };
}

async function n8nGet(pathAndQuery) {
  const { base, key } = n8nConfig();
  if (!key) fail('n8n sin conectar: falta N8N_API_KEY o N8N_API_KEY_FILE en el servidor.', 409);
  const res = await fetch(base + pathAndQuery, { headers: { 'X-N8N-API-KEY': key, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) fail('n8n respondió ' + res.status, 409);
  return res.json();
}

async function n8nWorkflows() {
  const out = [];
  let cursor = '';
  for (let i = 0; i < 20; i++) {
    const d = await n8nGet('/workflows?limit=250' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    for (const w of d.data || []) out.push({ id: w.id, name: w.name, active: !!w.active });
    cursor = d.nextCursor;
    if (!cursor) break;
  }
  return out.sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
}

// Cuenta ejecuciones por día local desde `desde` (YYYY-MM-DD, o '' = todo lo que tenga n8n).
async function contarEjecuciones(workflowId, desde, tope = 400) {
  const dias = {};
  let cursor = '';
  let completo = true;
  for (let pagina = 0; pagina < tope; pagina++) {
    const d = await n8nGet(`/executions?workflowId=${encodeURIComponent(workflowId)}&limit=250&includeData=false` + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    let paso = false;
    for (const e of d.data || []) {
      const cuando = e.startedAt || e.createdAt;
      if (!cuando) continue;
      const dia = hoyLocal(new Date(cuando));
      if (desde && dia < desde) { paso = true; break; }
      if (!dias[dia]) dias[dia] = { ok: 0, error: 0 };
      if (['error', 'crashed'].includes(e.status)) dias[dia].error++;
      else if (e.status !== 'canceled') dias[dia].ok++;
    }
    cursor = d.nextCursor;
    if (paso || !cursor) break;
    if (pagina === tope - 1) completo = false;
  }
  return { dias, completo };
}

// ── Lectura de bases de clientes (recetas) ──
const poolsRecetas = new Map();
function poolReceta(receta) {
  const url = process.env[receta.env];
  if (!url) fail(`Falta la variable ${receta.env} en el servidor.`, 409);
  if (!poolsRecetas.has(receta.env)) {
    const p = new Pool({ connectionString: url, ssl: /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false }, max: 2, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
    p.on('error', () => {});
    poolsRecetas.set(receta.env, p);
  }
  return poolsRecetas.get(receta.env);
}

async function correrReceta(nombre, desdeMes) {
  const receta = RECETAS[nombre];
  const resultado = {};
  let ultimoError;
  for (let intento = 0; intento < 3; intento++) {
    let client;
    try {
      client = await poolReceta(receta).connect();
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '60s'");
      for (const sql of receta.consultas) {
        const { rows } = await client.query(sql, [desdeMes + '-01']);
        for (const row of rows) {
          if (!row.mes) continue;
          for (const [k, v] of Object.entries(row)) {
            if (k === 'mes' || !METRICAS[k]) continue;
            (resultado[k] ||= {})[row.mes] = Number(v) || 0;
          }
        }
      }
      await client.query('COMMIT');
      return resultado;
    } catch (err) {
      ultimoError = err;
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (err.status) throw err;
      await new Promise(r => setTimeout(r, 1500 * (intento + 1)));
    } finally {
      if (client) client.release();
    }
  }
  throw ultimoError;
}

// ── Texto para el chat de preguntas ──
// Los números de los últimos 13 meses, compactos y legibles por el modelo. Lo cargado a mano lleva *.
function textoParaPreguntas(clientes, ahora = new Date()) {
  const hoy = hoyLocal(ahora);
  const mes = hoy.slice(0, 7);
  const [y, m] = mes.split('-').map(Number);
  const diasMes = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const desde = sumarMes(mes, -12);
  const num = n => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(n);
  const bloques = [];
  const sinDatos = [];
  for (const c of clientes.filter(x => !x.oculto)) {
    const lineas = [];
    for (const [k, def] of Object.entries(METRICAS)) {
      const valores = Object.entries(c.metricas[k] || {}).filter(([mm]) => mm >= desde).sort(([a], [b]) => a.localeCompare(b));
      if (valores.length) lineas.push(`  ${k} (${def.label}): ` + valores.map(([mm, v]) => `${mm}=${num(v.valor)}${v.origen === 'manual' ? '*' : ''}`).join(', '));
    }
    const fuentes = c.fuentes.map(f => {
      const clave = f.tipo === 'n8n' ? 'n8n' : 'receta:' + f.receta;
      const st = c.estadoFuentes.find(e => e.fuente === clave);
      return (f.tipo === 'n8n' ? 'bot de n8n' : 'base del cliente') + (st && !st.ok ? ' (CON ERROR: ' + st.detalle + ')' : '');
    });
    const cabecera = `CLIENTE: ${c.nombre} | ${CATEGORIAS[c.categoria] || 'Sin categoría'} | estado del proyecto en el tablero: ${c.estado}` + (fuentes.length ? ` | se mide con: ${fuentes.join(', ')}` : ' | sin fuente en vivo') + (c.descripcion ? `\n  qué hace: ${c.descripcion}` : '');
    if (lineas.length) bloques.push(cabecera + '\n' + lineas.join('\n'));
    else sinDatos.push(`${c.nombre} (${CATEGORIAS[c.categoria] || 'Sin categoría'})`);
  }
  if (sinDatos.length) bloques.push('PROYECTOS SIN NÚMEROS TODAVÍA: ' + sinDatos.join(', '));
  return {
    fecha: `${hoy} (el mes ${mes} va por el día ${Number(hoy.slice(8, 10))} de ${diasMes}: sus números son parciales)`,
    datos: bloques.join('\n\n') || 'Todavía no hay números cargados.',
  };
}

// ── Refresco ──
function register(app, pool, requireAdmin, opciones = {}) {
  let refrescando = null;
  let ultimoRefresco = null;
  const n8nApi = opciones.n8n || { workflows: n8nWorkflows, contar: contarEjecuciones };
  const recetasApi = opciones.recetas || { correr: correrReceta };

  async function marcar(cardId, fuente, ok, detalle) {
    await pool.query(`INSERT INTO analisis_estado (card_id, fuente, ok, detalle, revisado_en) VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (card_id, fuente) DO UPDATE SET ok = EXCLUDED.ok, detalle = EXCLUDED.detalle, revisado_en = NOW()`, [cardId, fuente, ok, String(detalle || '').slice(0, 500)]);
  }

  async function refrescarCard(cfg) {
    for (const f of cfg.fuentes || []) {
      if (f.tipo === 'n8n') {
        const clave = 'n8n';
        try {
          const { rows } = await pool.query(`SELECT max(dia)::text AS ultimo FROM analisis_diario WHERE card_id = $1 AND metrica = 'mensajes_bot'`, [cfg.card_id]);
          // Se recuentan los dos últimos días contados (pueden haber quedado a medias); lo anterior queda fijo.
          const desde = rows[0]?.ultimo ? new Date(Date.parse(rows[0].ultimo + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10) : '';
          const total = {};
          let completo = true;
          for (const wf of f.workflows) {
            const r = await n8nApi.contar(wf, desde);
            completo = completo && r.completo;
            for (const [dia, c] of Object.entries(r.dias)) {
              total[dia] ||= { ok: 0, error: 0 };
              total[dia].ok += c.ok; total[dia].error += c.error;
            }
          }
          if (desde) await pool.query(`DELETE FROM analisis_diario WHERE card_id = $1 AND metrica IN ('mensajes_bot', 'errores_bot') AND dia >= $2::date`, [cfg.card_id, desde]);
          for (const [dia, c] of Object.entries(total)) {
            for (const [metrica, valor] of [['mensajes_bot', c.ok], ['errores_bot', c.error]]) {
              await pool.query(`INSERT INTO analisis_diario (card_id, metrica, dia, valor) VALUES ($1, $2, $3, $4)
                ON CONFLICT (card_id, metrica, dia) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`, [cfg.card_id, metrica, dia, valor]);
            }
          }
          // Marca de "ya contado" aunque hoy no haya ejecuciones, para no recontar todo la próxima vez.
          if (!Object.keys(total).length) {
            await pool.query(`INSERT INTO analisis_diario (card_id, metrica, dia, valor) VALUES ($1, 'mensajes_bot', $2, 0) ON CONFLICT DO NOTHING`, [cfg.card_id, hoyLocal()]);
          }
          await marcar(cfg.card_id, clave, true, completo ? '' : 'Historial muy largo: se contó solo lo más reciente.');
        } catch (err) {
          await marcar(cfg.card_id, clave, false, err.message);
        }
      } else if (f.tipo === 'receta') {
        const clave = 'receta:' + f.receta;
        try {
          const desdeMes = cfg.desde && MES_RE.test(cfg.desde) ? cfg.desde : sumarMes(hoyLocal().slice(0, 7), -12);
          const datos = await recetasApi.correr(f.receta, desdeMes);
          await pool.query(`DELETE FROM analisis_mensual WHERE card_id = $1 AND origen = 'receta' AND mes >= $2`, [cfg.card_id, desdeMes]);
          for (const [metrica, meses] of Object.entries(datos)) {
            for (const [mes, valor] of Object.entries(meses)) {
              await pool.query(`INSERT INTO analisis_mensual (card_id, metrica, mes, origen, valor) VALUES ($1, $2, $3, 'receta', $4)
                ON CONFLICT (card_id, metrica, mes, origen) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`, [cfg.card_id, metrica, mes, valor]);
            }
          }
          await marcar(cfg.card_id, clave, true, '');
        } catch (err) {
          await marcar(cfg.card_id, clave, false, err.message);
        }
      }
    }
  }

  // Los refrescos van en fila, de a uno (dos a la vez se pisarían los días de n8n).
  // Un pedido que llega con otro en curso espera su turno; si ya hay uno igual esperando, se reusa.
  let cola = Promise.resolve();
  const esperando = new Map();
  function refrescarTodo(cardId = null) {
    const clave = cardId || '*';
    if (esperando.has('*')) return esperando.get('*');
    if (esperando.has(clave)) return esperando.get(clave);
    const tarea = cola.then(async () => {
      esperando.delete(clave);
      refrescando = true;
      try {
        const { rows } = await pool.query(`SELECT a.* FROM analisis_config a JOIN cards c ON c.id = a.card_id
          WHERE c.deleted_at IS NULL AND jsonb_array_length(a.fuentes) > 0 ${cardId ? 'AND a.card_id = $1' : ''}`, cardId ? [cardId] : []);
        for (const cfg of rows) {
          try { await refrescarCard(cfg); } catch (err) { console.error('[analisis] refresco', cfg.card_id, err.message); }
        }
        if (!cardId) ultimoRefresco = new Date();
      } finally { refrescando = esperando.size > 0; }
    });
    esperando.set(clave, tarea);
    cola = tarea.catch(() => {});
    return tarea;
  }

  async function leerTodo() {
    const [cards, cfgs, mensual, diario, estado] = await Promise.all([
      pool.query(`SELECT id, nf, rs, equipo, estado FROM cards WHERE deleted_at IS NULL AND equipo <> 'ventas' ORDER BY nf`),
      pool.query('SELECT * FROM analisis_config'),
      pool.query('SELECT card_id, metrica, mes, origen, valor FROM analisis_mensual'),
      pool.query(`SELECT card_id, metrica, to_char(dia, 'YYYY-MM') AS mes, sum(valor) AS valor, max(dia)::text AS ultimo FROM analisis_diario GROUP BY 1, 2, 3`),
      pool.query('SELECT * FROM analisis_estado'),
    ]);
    const cfgPor = new Map(cfgs.rows.map(r => [r.card_id, r]));
    const datos = new Map();
    const poner = (card, metrica, mes, valor, origen) => {
      const m = ((datos.get(card) || datos.set(card, {}).get(card))[metrica] ||= {});
      // Lo cargado a mano pisa a lo automático: es la corrección de alguien.
      if (origen === 'manual' || m[mes] == null || m[mes].origen !== 'manual') m[mes] = { valor: Number(valor), origen };
    };
    for (const r of mensual.rows) poner(r.card_id, r.metrica, r.mes, r.valor, r.origen);
    for (const r of diario.rows) poner(r.card_id, r.metrica, r.mes, r.valor, 'n8n');
    const estadoPor = {};
    for (const r of estado.rows) (estadoPor[r.card_id] ||= []).push({ fuente: r.fuente, ok: r.ok, detalle: r.detalle, revisadoEn: r.revisado_en });
    const clientes = cards.rows
      .filter(c => c.equipo === 'desarrollo' || cfgPor.has(c.id))
      .map(c => {
        const cfg = cfgPor.get(c.id) || {};
        return {
          cardId: c.id, nombre: c.nf || c.rs || 'Cliente', equipo: c.equipo, estado: c.estado,
          categoria: cfg.categoria || null, oculto: !!cfg.oculto, fuentes: cfg.fuentes || [],
          descripcion: cfg.descripcion || '', desde: cfg.desde || '',
          estadoFuentes: estadoPor[c.id] || [], metricas: datos.get(c.id) || {},
        };
      });
    return { clientes, otras: cards.rows.filter(c => !clientes.some(x => x.cardId === c.id)).map(c => ({ cardId: c.id, nombre: c.nf || c.rs || 'Cliente', equipo: c.equipo })) };
  }

  app.get('/api/analisis', requireAdmin, async (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const datos = await leerTodo();
      res.json({
        ...datos,
        categorias: CATEGORIAS,
        metricas: METRICAS,
        recetas: Object.fromEntries(Object.entries(RECETAS).map(([k, r]) => [k, { label: r.label, nota: r.nota, conectada: !!process.env[r.env] }])),
        n8nConectado: !!n8nConfig().key,
        actualizadoEn: ultimoRefresco,
        refrescando: !!refrescando,
      });
    } catch (err) { next(err); }
  });

  // Chat de preguntas: la app junta los números del momento y se los pasa al agente de n8n
  // (DeepSeek) junto con la pregunta. n8n no lee la base: contesta solo con lo que le llega.
  app.post('/api/analisis/preguntar', requireAdmin, async (req, res, next) => {
    try {
      const pregunta = typeof req.body?.pregunta === 'string' ? req.body.pregunta.trim() : '';
      if (!pregunta) fail('Escribí una pregunta.');
      if (pregunta.length > 2000) fail('La pregunta es demasiado larga.');
      const charla = typeof req.body?.charla === 'string' && /^[a-z0-9-]{6,40}$/i.test(req.body.charla) ? req.body.charla : 'general';
      const url = process.env.ANALISIS_N8N_URL;
      let clave = process.env.ANALISIS_N8N_CLAVE || '';
      if (!clave && process.env.ANALISIS_N8N_CLAVE_FILE) { try { clave = fs.readFileSync(process.env.ANALISIS_N8N_CLAVE_FILE, 'utf8').trim(); } catch (_) {} }
      if (!url || !clave) fail('El chat no está conectado: faltan ANALISIS_N8N_URL y la clave en el servidor.', 409);
      const { clientes } = await leerTodo();
      const body = { pregunta, sessionId: `analisis-${req.user.id}-${charla}`, ...textoParaPreguntas(clientes) };
      let respuesta;
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Analisis-Clave': clave }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
        respuesta = await r.json().catch(() => ({}));
        if (!r.ok) fail(`n8n respondió ${r.status}.`, 409);
      } catch (err) {
        if (err.status) throw err;
        fail(err.name === 'TimeoutError' ? 'El analista tardó demasiado en contestar. Probá de nuevo.' : 'No se pudo hablar con n8n.', 409);
      }
      if (!respuesta.respuesta) {
        console.error('[analisis] preguntar sin respuesta:', respuesta.error || '(vacío)');
        fail(/payment|402|balance|insufficient/i.test(respuesta.error || '') ? 'La cuenta de DeepSeek se quedó sin saldo.' : 'El analista no pudo contestar. Probá de nuevo en un rato.', 409);
      }
      res.json({ respuesta: String(respuesta.respuesta).slice(0, 20000) });
    } catch (err) { next(err); }
  });

  app.get('/api/analisis/n8n/workflows', requireAdmin, async (_req, res, next) => {
    try { res.json({ workflows: await n8nApi.workflows() }); } catch (err) { next(err); }
  });

  app.put('/api/analisis/:cardId/config', requireAdmin, async (req, res, next) => {
    try {
      const cfg = validarConfig(req.body || {});
      await cardAudit.withActor(pool, req.user, async client => {
        const { rows } = await client.query('SELECT id FROM cards WHERE id = $1 AND deleted_at IS NULL', [req.params.cardId]);
        if (!rows[0]) fail('Cliente no encontrado.', 404);
        const previo = await client.query('SELECT fuentes FROM analisis_config WHERE card_id = $1', [req.params.cardId]);
        await client.query(`INSERT INTO analisis_config (card_id, categoria, oculto, fuentes, descripcion, desde, updated_by, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (card_id) DO UPDATE SET categoria = EXCLUDED.categoria, oculto = EXCLUDED.oculto, fuentes = EXCLUDED.fuentes,
            descripcion = EXCLUDED.descripcion, desde = EXCLUDED.desde, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
          [req.params.cardId, cfg.categoria, cfg.oculto, JSON.stringify(cfg.fuentes), cfg.descripcion, cfg.desde, req.user.id]);
        // Si cambiaron los workflows de n8n, lo contado deja de valer: se vuelve a contar desde cero.
        const antes = (previo.rows[0]?.fuentes || []).find(f => f.tipo === 'n8n')?.workflows || [];
        const ahora = cfg.fuentes.find(f => f.tipo === 'n8n')?.workflows || [];
        if (antes.slice().sort().join() !== ahora.slice().sort().join()) {
          await client.query(`DELETE FROM analisis_diario WHERE card_id = $1`, [req.params.cardId]);
        }
        if (!cfg.fuentes.some(f => f.tipo === 'receta')) await client.query(`DELETE FROM analisis_mensual WHERE card_id = $1 AND origen = 'receta'`, [req.params.cardId]);
        await client.query(`DELETE FROM analisis_estado WHERE card_id = $1`, [req.params.cardId]);
      });
      refrescarTodo(req.params.cardId).catch(() => {});
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  app.put('/api/analisis/:cardId/manual', requireAdmin, async (req, res, next) => {
    try {
      const { mes, valores } = validarManual(req.body || {});
      const { rows } = await pool.query('SELECT id FROM cards WHERE id = $1 AND deleted_at IS NULL', [req.params.cardId]);
      if (!rows[0]) fail('Cliente no encontrado.', 404);
      for (const [metrica, valor] of Object.entries(valores)) {
        if (valor == null) await pool.query(`DELETE FROM analisis_mensual WHERE card_id = $1 AND metrica = $2 AND mes = $3 AND origen = 'manual'`, [req.params.cardId, metrica, mes]);
        else await pool.query(`INSERT INTO analisis_mensual (card_id, metrica, mes, origen, valor) VALUES ($1, $2, $3, 'manual', $4)
          ON CONFLICT (card_id, metrica, mes, origen) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`, [req.params.cardId, metrica, mes, valor]);
      }
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  app.post('/api/analisis/refrescar', requireAdmin, async (req, res, next) => {
    try {
      const cardId = typeof req.body?.cardId === 'string' ? req.body.cardId : null;
      await Promise.race([refrescarTodo(cardId), new Promise(r => setTimeout(r, 25000))]);
      res.json({ ok: true, refrescando: !!refrescando });
    } catch (err) { next(err); }
  });

  app.get('/api/analisis/:cardId/pdf', requireAdmin, async (req, res, next) => {
    try {
      const desde = MES_RE.test(req.query.desde || '') ? req.query.desde : sumarMes(hoyLocal().slice(0, 7), -5);
      const hasta = MES_RE.test(req.query.hasta || '') ? req.query.hasta : hoyLocal().slice(0, 7);
      if (hasta < desde) fail('El mes final tiene que ser posterior al inicial.');
      const { clientes } = await leerTodo();
      const cliente = clientes.find(c => c.cardId === req.params.cardId);
      if (!cliente) fail('Cliente no encontrado.', 404);
      const notas = cliente.fuentes.filter(f => f.tipo === 'receta').map(f => RECETAS[f.receta]?.nota).filter(Boolean);
      const { construirPdf } = require('./analisis-pdf');
      const buffer = await construirPdf({ cliente, desde, hasta, meses: mesesEntre(desde, hasta), categorias: CATEGORIAS, metricas: METRICAS, notas, analisis: typeof req.query.texto === 'string' ? req.query.texto.slice(0, 1500) : '' });
      const nombre = cliente.nombre.normalize('NFD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'cliente';
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="analisis-${nombre}-${desde}-a-${hasta}.pdf"`);
      res.send(buffer);
    } catch (err) { next(err); }
  });

  if (opciones.automatico !== false) {
    const minutos = Math.max(2, Number(process.env.ANALISIS_REFRESCO_MIN) || 10);
    setTimeout(() => refrescarTodo().catch(err => console.error('[analisis]', err.message)), 30000).unref();
    setInterval(() => refrescarTodo().catch(err => console.error('[analisis]', err.message)), minutos * 60000).unref();
  }

  return { refrescarTodo, leerTodo };
}

module.exports = { schema, register, validarConfig, validarManual, mesesEntre, sumarMes, textoParaPreguntas, CATEGORIAS, METRICAS, RECETAS, contarEjecuciones };
