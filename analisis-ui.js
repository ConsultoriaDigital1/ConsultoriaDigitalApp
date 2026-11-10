// Análisis: tablero en vivo de los proyectos por cliente y por categoría (solo admin).
// Lee /api/analisis cada minuto mientras la pestaña está abierta y genera el PDF del cliente.
let analisisData = null;
let analisisTimer = null;
let analisisPedido = 0;
let analisisWorkflows = null;
const analisisEstado = { categoria: 'todas', cliente: '', desde: '', hasta: '', ocultos: false };

const AN_CLAVES = ['turnos_bot', 'turnos_total', 'conv_bot', 'conversaciones', 'recordatorios', 'asistencias', 'mensajes_bot', 'errores_bot', 'ventas', 'leads', 'cobros', 'usuarios', 'visitas'];
const AN_MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

(function analisisEstilos() {
  if (document.getElementById('analisis-estilos')) return;
  const css = `
  .an-wrap{padding:22px 24px 40px;overflow:auto;flex:1;min-height:0;color:var(--text)}
  .an-bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:16px}
  .an-chips{display:flex;flex-wrap:wrap;gap:6px}
  .an-chip{border:1px solid var(--border2);background:var(--surface);color:var(--text);border-radius:999px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer}
  .an-chip[aria-pressed=true]{background:var(--lime);color:#11161b;border-color:var(--lime);font-weight:700}
  .an-chip small{opacity:.7;margin-left:4px}
  .an-bar label{display:flex;gap:6px;align-items:center;font-size:13px;color:var(--muted)}
  .an-bar input,.an-bar select{background:var(--surface);color:var(--text-hi);border:1px solid var(--border2);border-radius:8px;padding:6px 8px;font:inherit;font-size:13px}
  .an-live{margin-left:auto;font-size:12px;color:var(--muted);display:flex;align-items:center;gap:8px}
  .an-dot{width:8px;height:8px;border-radius:50%;background:var(--success);display:inline-block}
  .an-dot.off{background:var(--muted)} .an-dot.err{background:var(--danger)}
  .an-resumen{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:18px}
  .an-tile{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
  .an-tile b{display:block;font-size:28px;color:var(--lime);line-height:1.1;font-variant-numeric:tabular-nums}
  .an-tile span{font-size:12px;color:var(--muted)}
  .an-tile em{display:block;font-style:normal;font-size:11px;margin-top:6px;color:var(--muted)}
  .an-up{color:var(--success)!important} .an-down{color:var(--danger)!important}
  .an-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
  .an-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
  .an-card header{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
  .an-card h3{margin:0;font-size:16px;color:var(--text-hi)}
  .an-badge{font-size:11px;border-radius:999px;padding:2px 8px;background:var(--surface3);color:var(--text);white-space:nowrap}
  .an-badge.sin{background:transparent;border:1px dashed var(--border2);color:var(--muted)}
  .an-kv{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .an-kv div{background:var(--bg2);border-radius:8px;padding:8px 10px}
  .an-kv b{display:block;font-size:18px;color:var(--text-hi);font-variant-numeric:tabular-nums}
  .an-kv span{font-size:11px;color:var(--muted)}
  .an-kv small{font-size:11px;margin-left:4px}
  .an-fuentes{font-size:11px;color:var(--muted);display:flex;flex-wrap:wrap;gap:8px}
  .an-fuentes span{display:inline-flex;gap:5px;align-items:center}
  .an-acciones{display:flex;gap:6px;flex-wrap:wrap;margin-top:auto}
  .an-vacio{color:var(--muted);font-size:13px;padding:6px 0}
  .an-seccion{margin:22px 0 10px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
  .an-graficos{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:14px}
  .an-grafico{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
  .an-grafico h4{margin:0 0 2px;font-size:14px;color:var(--text-hi)} .an-grafico p{margin:0 0 8px;font-size:11px;color:var(--muted)}
  .an-grafico svg{width:100%;height:auto;display:block}
  .an-leyenda{display:flex;gap:14px;font-size:11px;color:var(--muted);margin-top:4px}
  .an-leyenda i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:-1px}
  .an-tabla{width:100%;border-collapse:collapse;font-size:13px;background:var(--surface);border-radius:12px;overflow:hidden}
  .an-tabla th,.an-tabla td{padding:7px 10px;border-bottom:1px solid var(--border);text-align:right;font-variant-numeric:tabular-nums}
  .an-tabla th:first-child,.an-tabla td:first-child{text-align:left}
  .an-tabla thead th{color:var(--muted);font-weight:600;font-size:12px}
  .an-tabla td.manual{color:var(--warn)}
  .an-volver{margin-bottom:12px}
  .an-dialog{position:fixed;inset:0;margin:auto;height:fit-content;background:var(--surface);color:var(--text);border:1px solid var(--border2);border-radius:14px;padding:0;width:min(720px,94vw);max-height:90vh}
  .an-dialog::backdrop{background:rgba(0,0,0,.55)}
  .an-dialog form{padding:20px 22px;display:grid;gap:12px}
  .an-dialog h3{margin:0;color:var(--text-hi)}
  .an-dialog label{display:grid;gap:4px;font-size:13px;color:var(--muted)}
  .an-dialog input,.an-dialog select,.an-dialog textarea{background:var(--bg2);color:var(--text-hi);border:1px solid var(--border2);border-radius:8px;padding:8px;font:inherit;font-size:14px}
  .an-dialog .an-fila{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .an-wf{max-height:220px;overflow:auto;border:1px solid var(--border2);border-radius:8px;padding:6px 10px;background:var(--bg2)}
  .an-wf label{display:flex;gap:8px;align-items:center;color:var(--text);padding:3px 0}
  .an-wf label.inactivo{opacity:.55}
  .an-ayuda{font-size:12px;color:var(--muted);margin:0}
  .an-dialog .an-pie{display:flex;gap:8px;justify-content:flex-end}
  .an-chat-boton{position:fixed;right:24px;bottom:24px;z-index:900;background:var(--lime);color:#11161b;border:0;border-radius:999px;padding:12px 18px;font:inherit;font-weight:800;font-size:14px;box-shadow:var(--shadow-lg);cursor:pointer}
  .an-chat{position:fixed;right:24px;bottom:24px;z-index:901;width:min(460px,calc(100vw - 32px));height:min(640px,calc(100vh - 120px));background:var(--surface);border:1px solid var(--border2);border-radius:16px;box-shadow:var(--shadow-lg);display:flex;flex-direction:column;overflow:hidden}
  .an-chat header{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border)}
  .an-chat header strong{flex:1;color:var(--text-hi);font-size:15px}
  .an-chat header button{background:none;border:0;color:var(--muted);font:inherit;font-size:12px;cursor:pointer;padding:4px 6px}
  .an-chat-msjs{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
  .an-msj{max-width:88%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.45;white-space:normal;overflow-wrap:anywhere}
  .an-msj.yo{align-self:flex-end;background:var(--surface3);color:var(--text-hi);border-bottom-right-radius:4px}
  .an-msj.bot{align-self:flex-start;background:var(--bg2);color:var(--text);border-bottom-left-radius:4px}
  .an-msj.bot b{color:var(--text-hi)} .an-msj.error{color:var(--danger)}
  .an-msj.pensando{color:var(--muted);font-style:italic}
  .an-sugerencias{display:flex;flex-direction:column;gap:6px}
  .an-sugerencias button{text-align:left;background:var(--bg2);border:1px solid var(--border2);color:var(--text);border-radius:10px;padding:8px 10px;font:inherit;font-size:13px;cursor:pointer}
  .an-chat form{display:flex;gap:8px;padding:10px;border-top:1px solid var(--border)}
  .an-chat textarea{flex:1;resize:none;background:var(--bg2);color:var(--text-hi);border:1px solid var(--border2);border-radius:10px;padding:8px 10px;font:inherit;font-size:14px;max-height:120px}
  @media(max-width:600px){.an-chat{right:8px;bottom:70px;height:calc(100vh - 150px)}.an-chat-boton{right:12px;bottom:78px}}
  @media(max-width:600px){.an-wrap{padding:16px}.an-graficos{grid-template-columns:1fr}.an-dialog .an-fila{grid-template-columns:1fr}.an-live{margin-left:0}}`;
  const tag = document.createElement('style');
  tag.id = 'analisis-estilos';
  tag.textContent = css;
  document.head.appendChild(tag);
})();

// ── Utilidades ──
function anNum(n) { return n == null ? '—' : Math.round(n).toLocaleString('es-AR'); }
function anMesHoy() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' }).slice(0, 7); }
function anSumarMes(mes, d) { const [y, m] = mes.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + d, 1)).toISOString().slice(0, 7); }
function anMeses(desde, hasta) { const out = []; let m = desde; while (m <= hasta && out.length < 60) { out.push(m); m = anSumarMes(m, 1); } return out; }
function anMesCorto(m) { return AN_MES[Number(m.slice(5, 7)) - 1] + (m.slice(5, 7) === '01' ? ' ' + m.slice(2, 4) : ''); }
function anValor(cliente, metrica, mes) { return cliente.metricas[metrica]?.[mes]?.valor ?? null; }
function anSuma(cliente, metrica, meses) { const v = meses.map(m => anValor(cliente, metrica, m)); return v.some(x => x != null) ? v.reduce((a, x) => a + (x || 0), 0) : null; }
function anDiasMes(mes) { const [y, m] = mes.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
// Con el mes en curso no se compara el total (10 días contra 30 siempre da "−70 %"):
// se compara el ritmo por día contra el del mes anterior.
function anCambio(actual, previo, mes = analisisEstado.hasta) {
  if (actual == null || previo == null || !previo) return '';
  const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });
  const enCurso = mes === hoy.slice(0, 7);
  const base = enCurso ? previo / anDiasMes(anSumarMes(mes, -1)) * Number(hoy.slice(8, 10)) : previo;
  const c = Math.round((actual - base) / base * 100);
  return `<small class="${c >= 0 ? 'an-up' : 'an-down'}" title="${enCurso ? 'Mes en curso: compara el ritmo por día con el mes anterior' : 'Contra el mes anterior'}">${c > 0 ? '+' : ''}${c}%${enCurso ? ' ritmo' : ''}</small>`;
}
function anHace(fecha) {
  if (!fecha) return 'sin actualizar todavía';
  const s = Math.round((Date.now() - new Date(fecha)) / 1000);
  if (s < 60) return 'actualizado recién';
  if (s < 3600) return `actualizado hace ${Math.round(s / 60)} min`;
  return `actualizado ${new Date(fecha).toLocaleString('es-AR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}`;
}
function anMetricasDe(cliente) { return AN_CLAVES.filter(k => cliente.metricas[k] && Object.keys(cliente.metricas[k]).length); }

// ── Ciclo de vida de la pestaña ──
function stopAnalisis() { clearInterval(analisisTimer); analisisTimer = null; analisisPedido++; ocultarChatAnalisis(); }

async function renderAnalisis() {
  stopAnalisis();
  if (!isAdmin()) return;
  mostrarChatAnalisis();
  if (!analisisEstado.hasta) { analisisEstado.hasta = anMesHoy(); analisisEstado.desde = anSumarMes(analisisEstado.hasta, -5); }
  const root = $('analisis-root');
  if (!analisisData) root.innerHTML = '<p class="an-vacio">Cargando…</p>';
  await cargarAnalisis();
  analisisTimer = setInterval(() => { if (activeTab === 'analisis' && !document.hidden && !document.querySelector('.an-dialog[open]')) cargarAnalisis(); }, 60000);
}

async function cargarAnalisis() {
  const pedido = ++analisisPedido;
  try {
    const data = await api('/api/analisis');
    if (pedido !== analisisPedido || activeTab !== 'analisis') return;
    analisisData = data;
    dibujarAnalisis();
  } catch (err) {
    if (pedido === analisisPedido) { $('analisis-root').innerHTML = '<p class="an-vacio">No se pudo cargar el análisis.</p>'; toast(err.message, 'error'); }
  }
}

async function refrescarAnalisis(cardId = '') {
  const boton = $('an-refrescar');
  if (boton) { boton.disabled = true; boton.textContent = 'Actualizando…'; }
  try {
    await api('/api/analisis/refrescar', { method: 'POST', body: JSON.stringify(cardId ? { cardId } : {}) });
    await cargarAnalisis();
  } catch (err) { toast(err.message, 'error'); }
  finally { if (boton) { boton.disabled = false; boton.textContent = 'Actualizar ahora'; } }
}

function anVisibles() {
  const d = analisisData;
  const peso = c => (anMetricasDe(c).length ? 0 : c.fuentes.length ? 1 : c.categoria ? 2 : 3);
  return d.clientes.filter(c => (analisisEstado.ocultos || !c.oculto)
    && (analisisEstado.categoria === 'todas' || (analisisEstado.categoria === 'sin' ? !c.categoria : c.categoria === analisisEstado.categoria)))
    .sort((a, b) => peso(a) - peso(b) || a.nombre.localeCompare(b.nombre));
}

function dibujarAnalisis() {
  const d = analisisData;
  if (!d) return;
  if (analisisEstado.cliente && d.clientes.some(c => c.cardId === analisisEstado.cliente)) { dibujarDetalle(); return; }
  analisisEstado.cliente = '';
  const conteo = k => d.clientes.filter(c => !c.oculto && (k === 'todas' || (k === 'sin' ? !c.categoria : c.categoria === k))).length;
  const chips = [['todas', 'Todas'], ...Object.entries(d.categorias), ['sin', 'Sin categoría']]
    .map(([k, l]) => `<button class="an-chip" type="button" aria-pressed="${analisisEstado.categoria === k}" onclick="analisisEstado.categoria='${k}';dibujarAnalisis()">${esc(l)}<small>${conteo(k)}</small></button>`).join('');
  const errores = d.clientes.flatMap(c => c.estadoFuentes.filter(f => !f.ok)).length;
  const lista = anVisibles();
  const mes = analisisEstado.hasta, previo = anSumarMes(mes, -1);
  const tot = (k, m) => lista.reduce((a, c) => a + (anValor(c, k, m) || 0), 0);
  const tiles = [
    ['mensajes_bot', 'mensajes atendidos por los bots'],
    ['turnos_bot', 'turnos dados por bots'],
    ['conv_bot', 'conversaciones resueltas sin una persona'],
    ['asistencias', 'asistencias confirmadas'],
  ].filter(([k]) => lista.some(c => anValor(c, k, mes) != null || anValor(c, k, previo) != null))
    .map(([k, l]) => `<div class="an-tile"><b>${anNum(tot(k, mes))}</b><span>${l} en ${anMesCorto(mes)}</span><em>${anCambio(tot(k, mes), tot(k, previo)) || '&nbsp;'} vs. ${anMesCorto(previo)}</em></div>`);
  tiles.unshift(`<div class="an-tile"><b>${lista.length}</b><span>proyectos en esta vista</span><em>${lista.filter(c => c.fuentes.length).length} conectados en vivo${errores ? ` · <span class="an-down">${errores} fuente${errores > 1 ? 's' : ''} con error</span>` : ''}</em></div>`);

  $('analisis-root').innerHTML = `
    <div class="an-bar"><div class="an-chips">${chips}</div>
      <span class="an-live"><span class="an-dot ${d.refrescando ? '' : d.actualizadoEn ? '' : 'off'}"></span>${esc(anHace(d.actualizadoEn))} · se mira solo cada minuto</span></div>
    <div class="an-bar">
      <label>Mes <input type="month" value="${esc(analisisEstado.hasta)}" onchange="analisisEstado.hasta=this.value||anMesHoy();analisisEstado.desde=anSumarMes(analisisEstado.hasta,-5);dibujarAnalisis()"></label>
      <label><input type="checkbox" ${analisisEstado.ocultos ? 'checked' : ''} onchange="analisisEstado.ocultos=this.checked;dibujarAnalisis()"> Mostrar ocultos</label>
      <button id="an-refrescar" class="btn btn-ghost btn-sm" type="button" onclick="refrescarAnalisis()">Actualizar ahora</button>
      ${d.otras.length ? `<label>Sumar otro proyecto <select onchange="if(this.value)abrirConfigAnalisis(this.value)"><option value="">Elegí…</option>${d.otras.map(o => `<option value="${esc(o.cardId)}">${esc(o.nombre)} (${esc(o.equipo)})</option>`).join('')}</select></label>` : ''}
    </div>
    ${!d.n8nConectado ? '<p class="an-vacio">⚠ n8n no está conectado en el servidor: los bots no van a mostrar mensajes hasta que se configure.</p>' : ''}
    <div class="an-resumen">${tiles.join('')}</div>
    <div class="an-grid">${lista.map(c => tarjetaAnalisis(c, mes, previo)).join('') || '<p class="an-vacio">No hay proyectos en esta categoría.</p>'}</div>`;
}

function tarjetaAnalisis(c, mes, previo) {
  const id = encodeURIComponent(c.cardId);
  const claves = anMetricasDe(c).slice(0, 4);
  const cat = c.categoria ? analisisData.categorias[c.categoria] : 'Sin categoría';
  const fuentes = c.fuentes.map(f => {
    const clave = f.tipo === 'n8n' ? 'n8n' : 'receta:' + f.receta;
    const st = c.estadoFuentes.find(e => e.fuente === clave);
    const nombre = f.tipo === 'n8n' ? `n8n (${f.workflows.length} workflow${f.workflows.length > 1 ? 's' : ''})` : (analisisData.recetas[f.receta]?.label || f.receta);
    return `<span title="${esc(st?.detalle || '')}"><span class="an-dot ${!st ? 'off' : st.ok ? '' : 'err'}"></span>${esc(nombre)}${st && !st.ok ? ' — error' : ''}</span>`;
  });
  return `<article class="an-card">
    <header><h3>${esc(c.nombre)}</h3><span class="an-badge ${c.categoria ? '' : 'sin'}">${esc(cat)}</span></header>
    ${claves.length ? `<div class="an-kv">${claves.map(k => `<div><b>${anNum(anValor(c, k, mes))}${anCambio(anValor(c, k, mes), anValor(c, k, previo))}</b><span>${esc(analisisData.metricas[k].label)} · ${anMesCorto(mes)}</span></div>`).join('')}</div>` : `<p class="an-vacio">${c.fuentes.length ? 'Conectado: los números aparecen en la próxima actualización.' : 'Sin números todavía. Conectá una fuente o cargalos a mano.'}</p>`}
    <div class="an-fuentes">${fuentes.join('') || '<span><span class="an-dot off"></span>Sin fuente en vivo</span>'}</div>
    <div class="an-acciones">
      <button class="btn btn-primary btn-sm" type="button" onclick="verClienteAnalisis('${id}')">Ver detalle</button>
      <button class="btn btn-ghost btn-sm" type="button" onclick="abrirPdfAnalisis('${id}')">PDF</button>
      <button class="btn btn-ghost btn-sm" type="button" onclick="abrirConfigAnalisis('${id}')">Configurar</button>
    </div></article>`;
}

// ── Detalle de un cliente ──
function verClienteAnalisis(id) { analisisEstado.cliente = decodeURIComponent(id); dibujarAnalisis(); $('analisis-root').scrollTop = 0; }

function dibujarDetalle() {
  const c = analisisData.clientes.find(x => x.cardId === analisisEstado.cliente);
  const meses = anMeses(analisisEstado.desde, analisisEstado.hasta);
  const id = encodeURIComponent(c.cardId);
  const claves = anMetricasDe(c);
  const tiles = claves.filter(k => k !== 'errores_bot').slice(0, 6).map(k => `<div class="an-tile"><b>${anNum(anSuma(c, k, meses))}</b><span>${esc(analisisData.metricas[k].label)} en el período</span></div>`);
  const conv = anSuma(c, 'conversaciones', meses), convBot = anSuma(c, 'conv_bot', meses);
  if (conv && convBot != null) tiles.splice(1, 0, `<div class="an-tile"><b>${Math.round(100 * convBot / conv)} %</b><span>de las conversaciones las resolvió el bot</span></div>`);
  const graficos = [];
  if (claves.includes('turnos_total') || claves.includes('turnos_bot')) graficos.push(svgBarras('Turnos atendidos por mes', 'Según quién dio el turno', meses, [['Bot', '#d5f114', m => anValor(c, 'turnos_bot', m)], ['Recepción', '#5b6b78', m => (anValor(c, 'turnos_total', m) == null ? null : Math.max(0, anValor(c, 'turnos_total', m) - (anValor(c, 'turnos_bot', m) || 0)))]]));
  if (claves.includes('conversaciones')) graficos.push(svgBarras('Conversaciones por mes', 'Resueltas por el bot y derivadas a una persona', meses, [['Resueltas por el bot', '#d5f114', m => anValor(c, 'conv_bot', m)], ['Pasaron a una persona', '#5b6b78', m => (anValor(c, 'conversaciones', m) == null ? null : Math.max(0, anValor(c, 'conversaciones', m) - (anValor(c, 'conv_bot', m) || 0)))]]));
  if (claves.includes('recordatorios')) graficos.push(svgBarras('Recordatorios por mes', 'Confirmaron asistencia y sin confirmar', meses, [['Confirmaron', '#d5f114', m => anValor(c, 'asistencias', m)], ['Sin confirmar', '#5b6b78', m => (anValor(c, 'recordatorios', m) == null ? null : Math.max(0, anValor(c, 'recordatorios', m) - (anValor(c, 'asistencias', m) || 0)))]]));
  if (claves.includes('mensajes_bot')) graficos.push(svgBarras('Mensajes atendidos por el bot', 'Ejecuciones de n8n por mes; en rojo, las que fallaron', meses, [['Atendidos', '#d5f114', m => anValor(c, 'mensajes_bot', m)], ['Con error', '#f87168', m => anValor(c, 'errores_bot', m)]]));
  for (const k of ['ventas', 'leads', 'cobros', 'usuarios', 'visitas'].filter(k => claves.includes(k))) graficos.push(svgBarras(analisisData.metricas[k].label + ' por mes', '', meses, [[analisisData.metricas[k].label, '#d5f114', m => anValor(c, k, m)]]));
  const tabla = claves.length ? `<table class="an-tabla"><thead><tr><th>Métrica</th>${meses.map(m => `<th>${anMesCorto(m)}</th>`).join('')}</tr></thead><tbody>${claves.map(k => `<tr><td>${esc(analisisData.metricas[k].label)}</td>${meses.map(m => { const v = c.metricas[k]?.[m]; return `<td class="${v?.origen === 'manual' ? 'manual' : ''}" title="${v ? 'Origen: ' + v.origen : ''}">${anNum(v?.valor)}</td>`; }).join('')}</tr>`).join('')}</tbody></table><p class="an-ayuda">En amarillo, lo cargado a mano (pisa a lo automático de ese mes).</p>` : '<p class="an-vacio">Todavía no hay números para este proyecto.</p>';
  const errores = c.estadoFuentes.filter(f => !f.ok);
  $('analisis-root').innerHTML = `
    <button class="btn btn-ghost btn-sm an-volver" type="button" onclick="analisisEstado.cliente='';dibujarAnalisis()">‹ Todos los proyectos</button>
    <div class="an-bar"><h2 style="margin:0;color:var(--text-hi)">${esc(c.nombre)}</h2><span class="an-badge ${c.categoria ? '' : 'sin'}">${esc(c.categoria ? analisisData.categorias[c.categoria] : 'Sin categoría')}</span>
      <span class="an-live"><span class="an-dot ${analisisData.actualizadoEn ? '' : 'off'}"></span>${esc(anHace(analisisData.actualizadoEn))}</span></div>
    ${c.descripcion ? `<p class="an-ayuda" style="margin-bottom:12px">${esc(c.descripcion)}</p>` : ''}
    ${errores.length ? `<p class="an-vacio an-down">⚠ ${errores.map(e => esc(e.fuente + ': ' + e.detalle)).join(' · ')}</p>` : ''}
    <div class="an-bar">
      <label>Desde <input type="month" value="${esc(analisisEstado.desde)}" onchange="analisisEstado.desde=this.value||analisisEstado.desde;dibujarAnalisis()"></label>
      <label>Hasta <input type="month" value="${esc(analisisEstado.hasta)}" onchange="analisisEstado.hasta=this.value||analisisEstado.hasta;dibujarAnalisis()"></label>
      <button class="btn btn-primary btn-sm" type="button" onclick="abrirPdfAnalisis('${id}')">Generar PDF para el cliente</button>
      <button class="btn btn-ghost btn-sm" type="button" onclick="abrirManualAnalisis('${id}')">Cargar a mano</button>
      <button class="btn btn-ghost btn-sm" type="button" onclick="abrirConfigAnalisis('${id}')">Configurar</button>
      <button id="an-refrescar" class="btn btn-ghost btn-sm" type="button" onclick="refrescarAnalisis('${esc(c.cardId)}')">Actualizar ahora</button>
    </div>
    ${tiles.length ? `<div class="an-resumen">${tiles.join('')}</div>` : ''}
    ${graficos.length ? `<div class="an-graficos">${graficos.join('')}</div>` : ''}
    <div class="an-seccion">Mes a mes</div>${tabla}`;
}

function svgBarras(titulo, sub, meses, series) {
  const W = 560, H = 220, izq = 44, abajo = 24, arriba = 16;
  const valores = series.map(([, , f]) => meses.map(f));
  const totales = meses.map((_, i) => valores.reduce((a, v) => a + (v[i] || 0), 0));
  const max = Math.max(1, ...totales);
  const pot = Math.pow(10, Math.floor(Math.log10(max)));
  const tope = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(f => f * pot).find(v => v >= max * 1.1) || 10 * pot;
  const alto = H - abajo - arriba, slot = (W - izq) / meses.length, bw = Math.min(40, slot * 0.6);
  let s = '';
  for (let k = 0; k <= 4; k++) { const y = arriba + alto - alto * k / 4; s += `<line x1="${izq}" x2="${W}" y1="${y}" y2="${y}" stroke="rgba(166,197,226,.12)"/><text x="${izq - 6}" y="${y + 3}" text-anchor="end" font-size="10" fill="#7a8a99">${anNum(tope * k / 4)}</text>`; }
  meses.forEach((m, i) => {
    const x = izq + slot * i + (slot - bw) / 2;
    let acum = 0;
    series.forEach(([, color], si) => {
      const v = valores[si][i] || 0; if (!v) return;
      const h = alto * v / tope, y = arriba + alto - alto * acum / tope - h;
      s += `<rect x="${x}" y="${y}" width="${bw}" height="${Math.max(.5, h)}" fill="${color}" rx="2"><title>${anMesCorto(m)} · ${esc(series[si][0])}: ${anNum(v)}</title></rect>`;
      acum += v;
    });
    if (totales[i]) s += `<text x="${x + bw / 2}" y="${arriba + alto - alto * totales[i] / tope - 4}" text-anchor="middle" font-size="10" font-weight="700" fill="#e6edf3">${anNum(totales[i])}</text>`;
    s += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#7a8a99">${anMesCorto(m)}</text>`;
  });
  return `<div class="an-grafico"><h4>${esc(titulo)}</h4>${sub ? `<p>${esc(sub)}</p>` : ''}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(titulo)}">${s}</svg><div class="an-leyenda">${series.map(([l, color]) => `<span><i style="background:${color}"></i>${esc(l)}</span>`).join('')}</div></div>`;
}

// ── Diálogos ──
function anDialogo(html) {
  let d = $('an-dialog');
  if (!d) { d = document.createElement('dialog'); d.id = 'an-dialog'; d.className = 'an-dialog'; document.body.appendChild(d); }
  d.innerHTML = html;
  if (!d.open) d.showModal();
  return d;
}
function cerrarAnDialogo() { const d = $('an-dialog'); if (d?.open) d.close(); }
function anCliente(id) {
  id = decodeURIComponent(id);
  return analisisData.clientes.find(c => c.cardId === id) || { cardId: id, nombre: analisisData.otras.find(o => o.cardId === id)?.nombre || 'Proyecto', categoria: null, fuentes: [], descripcion: '', desde: '', oculto: false };
}

async function abrirConfigAnalisis(id) {
  const c = anCliente(id);
  const n8n = c.fuentes.find(f => f.tipo === 'n8n')?.workflows || [];
  const receta = c.fuentes.find(f => f.tipo === 'receta')?.receta || '';
  anDialogo(`<form onsubmit="guardarConfigAnalisis(event,'${encodeURIComponent(c.cardId)}')">
    <h3>Configurar · ${esc(c.nombre)}</h3>
    <div class="an-fila">
      <label>Categoría<select name="categoria"><option value="">Sin categoría</option>${Object.entries(analisisData.categorias).map(([k, l]) => `<option value="${k}" ${c.categoria === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label>Contar desde (opcional)<input type="month" name="desde" value="${esc(c.desde)}"></label>
    </div>
    <label>Qué hace el proyecto (sale en la portada del PDF)<input name="descripcion" maxlength="300" value="${esc(c.descripcion)}" placeholder="Ej.: da turnos, manda recordatorios y confirma la asistencia por WhatsApp."></label>
    <label>Base del cliente<select name="receta"><option value="">Ninguna</option>${Object.entries(analisisData.recetas).map(([k, r]) => `<option value="${k}" ${receta === k ? 'selected' : ''}>${esc(r.label)}${r.conectada ? '' : ' (falta configurar en el servidor)'}</option>`).join('')}</select></label>
    <label>Workflows de n8n de este proyecto <input type="search" placeholder="Buscar…" oninput="filtrarWorkflowsAnalisis(this.value)"></label>
    <div class="an-wf" id="an-wf"><p class="an-ayuda">Cargando workflows…</p></div>
    <p class="an-ayuda">Cada ejecución de un workflow cuenta como un mensaje atendido. n8n borra las ejecuciones viejas: el historial se arma desde que se conecta.</p>
    <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="oculto" ${c.oculto ? 'checked' : ''}> Ocultar del tablero (no es un proyecto para medir)</label>
    <div class="an-pie"><button type="button" class="btn btn-ghost" onclick="cerrarAnDialogo()">Cancelar</button><button type="submit" class="btn btn-primary">Guardar</button></div>
  </form>`);
  try {
    if (!analisisWorkflows) analisisWorkflows = (await api('/api/analisis/n8n/workflows')).workflows;
    const caja = $('an-wf');
    if (!caja) return;
    const ordenados = [...analisisWorkflows].sort((a, b) => (n8n.includes(b.id) - n8n.includes(a.id)) || (b.active - a.active) || a.name.localeCompare(b.name));
    caja.innerHTML = ordenados.map(w => `<label class="${w.active ? '' : 'inactivo'}" data-nombre="${esc(w.name.toLowerCase())}"><input type="checkbox" name="wf" value="${esc(w.id)}" ${n8n.includes(w.id) ? 'checked' : ''}> ${esc(w.name)}${w.active ? '' : ' (apagado)'}</label>`).join('');
  } catch (err) {
    const caja = $('an-wf');
    if (caja) caja.innerHTML = `<p class="an-ayuda">No se pudo leer n8n: ${esc(err.message)}</p>${n8n.map(w => `<label><input type="checkbox" name="wf" value="${esc(w)}" checked> ${esc(w)}</label>`).join('')}`;
  }
}

function filtrarWorkflowsAnalisis(q) {
  q = q.trim().toLowerCase();
  document.querySelectorAll('#an-wf label[data-nombre]').forEach(l => { l.hidden = q && !l.dataset.nombre.includes(q); });
}

async function guardarConfigAnalisis(ev, id) {
  ev.preventDefault();
  const f = ev.target, boton = f.querySelector('[type=submit]');
  const wfs = [...f.querySelectorAll('input[name=wf]:checked')].map(i => i.value);
  const fuentes = [];
  if (f.receta.value) fuentes.push({ tipo: 'receta', receta: f.receta.value });
  if (wfs.length) fuentes.push({ tipo: 'n8n', workflows: wfs });
  boton.disabled = true;
  try {
    await api('/api/analisis/' + id + '/config', { method: 'PUT', body: JSON.stringify({ categoria: f.categoria.value, desde: f.desde.value, descripcion: f.descripcion.value, oculto: f.oculto.checked, fuentes }) });
    cerrarAnDialogo();
    toast('Guardado. Los números se actualizan en unos segundos.');
    await cargarAnalisis();
    setTimeout(() => { if (activeTab === 'analisis') cargarAnalisis(); }, 8000);
  } catch (err) { toast(err.message, 'error'); boton.disabled = false; }
}

function abrirManualAnalisis(id) {
  const c = anCliente(id);
  const mes = analisisEstado.hasta;
  anDialogo(`<form onsubmit="guardarManualAnalisis(event,'${encodeURIComponent(c.cardId)}')">
    <h3>Cargar a mano · ${esc(c.nombre)}</h3>
    <label>Mes<input type="month" name="mes" value="${esc(mes)}" required onchange="abrirManualAnalisisMes('${encodeURIComponent(c.cardId)}', this.value)"></label>
    <div class="an-fila" id="an-manual-campos">${camposManualAnalisis(c, mes)}</div>
    <p class="an-ayuda">Lo cargado a mano pisa al número automático de ese mes. Dejá vacío para borrar tu carga y volver al automático.</p>
    <div class="an-pie"><button type="button" class="btn btn-ghost" onclick="cerrarAnDialogo()">Cancelar</button><button type="submit" class="btn btn-primary">Guardar</button></div>
  </form>`);
}
function camposManualAnalisis(c, mes) {
  return AN_CLAVES.map(k => { const v = c.metricas?.[k]?.[mes]; return `<label>${esc(analisisData.metricas[k].label)}<input type="number" min="0" step="1" name="m_${k}" value="${v?.origen === 'manual' ? v.valor : ''}" placeholder="${v && v.origen !== 'manual' ? 'auto: ' + anNum(v.valor) : ''}"></label>`; }).join('');
}
function abrirManualAnalisisMes(id, mes) { $('an-manual-campos').innerHTML = camposManualAnalisis(anCliente(id), mes); }

async function guardarManualAnalisis(ev, id) {
  ev.preventDefault();
  const f = ev.target;
  const c = anCliente(id);
  const valores = {};
  for (const k of AN_CLAVES) {
    const input = f['m_' + k];
    const antes = c.metricas?.[k]?.[f.mes.value];
    if (input.value !== '') valores[k] = input.value;
    else if (antes?.origen === 'manual') valores[k] = null;
  }
  if (!Object.keys(valores).length) { toast('No cargaste ningún número.', 'error'); return; }
  try {
    await api('/api/analisis/' + id + '/manual', { method: 'PUT', body: JSON.stringify({ mes: f.mes.value, valores }) });
    cerrarAnDialogo(); toast('Cargado.'); await cargarAnalisis();
  } catch (err) { toast(err.message, 'error'); }
}

function abrirPdfAnalisis(id) {
  const c = anCliente(id);
  anDialogo(`<form onsubmit="descargarPdfAnalisis(event,'${encodeURIComponent(c.cardId)}')">
    <h3>PDF para el cliente · ${esc(c.nombre)}</h3>
    <div class="an-fila">
      <label>Desde<input type="month" name="desde" value="${esc(analisisEstado.desde)}" required></label>
      <label>Hasta<input type="month" name="hasta" value="${esc(analisisEstado.hasta)}" required></label>
    </div>
    <label>Análisis y próximos pasos (opcional, sale como última página)<textarea name="texto" rows="6" maxlength="1500" placeholder="Lo que vemos en los números y lo que proponemos para el mes que viene."></textarea></label>
    <p class="an-ayuda">Mismo formato que el de casos de éxito: portada, números grandes, gráficos por mes y la fuente al pie. Sin datos personales de pacientes ni clientes.</p>
    <div class="an-pie"><button type="button" class="btn btn-ghost" onclick="cerrarAnDialogo()">Cancelar</button><button type="submit" class="btn btn-primary">Descargar PDF</button></div>
  </form>`);
}

async function descargarPdfAnalisis(ev, id) {
  ev.preventDefault();
  const f = ev.target, boton = f.querySelector('[type=submit]');
  if (f.hasta.value < f.desde.value) { toast('El mes final tiene que ser posterior al inicial.', 'error'); return; }
  boton.disabled = true; boton.textContent = 'Generando…';
  try {
    const q = new URLSearchParams({ desde: f.desde.value, hasta: f.hasta.value, texto: f.texto.value });
    const res = await fetch('/api/analisis/' + id + '/pdf?' + q, { credentials: 'include' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo generar el PDF.');
    const blob = await res.blob();
    const nombre = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'analisis.pdf';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    cerrarAnDialogo();
  } catch (err) { toast(err.message, 'error'); boton.disabled = false; boton.textContent = 'Descargar PDF'; }
}

// ── Chat de preguntas (n8n + DeepSeek) ──
// Vive afuera de #analisis-root: el refresco de cada minuto redibuja el tablero y no tiene que borrar la charla.
const AN_CHAT_KEY = 'analisis-chat-v1';
const AN_SUGERENCIAS = [
  '¿Qué proyecto viene mejor este mes y cuál peor?',
  '¿Qué bots tuvieron más errores este mes?',
  'Resumime cómo viene Unimed para mandarle al cliente',
  '¿Qué porcentaje de las conversaciones resuelve solo el bot de Unimed, mes a mes?',
];
let anChat = (() => {
  try { const g = JSON.parse(sessionStorage.getItem(AN_CHAT_KEY)); if (g && Array.isArray(g.mensajes)) return { abierto: false, ...g, esperando: false }; } catch (_) {}
  return { abierto: false, charla: anNuevaCharlaId(), mensajes: [], esperando: false };
})();
function anNuevaCharlaId() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
function anGuardarChat() { try { sessionStorage.setItem(AN_CHAT_KEY, JSON.stringify({ abierto: anChat.abierto, charla: anChat.charla, mensajes: anChat.mensajes.slice(-40) })); } catch (_) {} }

// Lo que contesta el modelo se escapa entero; después se permiten solo negritas y saltos de línea.
function anTextoBot(t) {
  return esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/^#{1,4}\s*(.+)$/gm, '<b>$1</b>').replace(/\n/g, '<br>');
}

function mostrarChatAnalisis() {
  if (!$('an-chat-boton')) {
    const b = document.createElement('button');
    b.id = 'an-chat-boton'; b.className = 'an-chat-boton'; b.type = 'button';
    b.textContent = '💬 Preguntale al análisis';
    b.onclick = () => { anChat.abierto = true; anGuardarChat(); dibujarChatAnalisis(); };
    document.body.appendChild(b);
  }
  dibujarChatAnalisis();
}

function ocultarChatAnalisis() {
  $('an-chat-boton')?.remove();
  $('an-chat')?.remove();
}

function dibujarChatAnalisis() {
  const boton = $('an-chat-boton');
  if (boton) boton.hidden = anChat.abierto;
  let panel = $('an-chat');
  if (!anChat.abierto) { panel?.remove(); return; }
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'an-chat'; panel.className = 'an-chat'; panel.setAttribute('aria-label', 'Preguntas sobre el análisis');
    panel.innerHTML = `<header><strong>Preguntale al análisis</strong><button type="button" onclick="nuevaCharlaAnalisis()">Nueva charla</button><button type="button" onclick="anChat.abierto=false;anGuardarChat();dibujarChatAnalisis()" aria-label="Cerrar">✕</button></header>
      <div class="an-chat-msjs" id="an-chat-msjs" aria-live="polite"></div>
      <form onsubmit="preguntarAnalisis(event)"><textarea id="an-chat-input" rows="2" maxlength="2000" placeholder="Ej.: ¿cómo viene MedalCap contra el mes pasado?" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();this.form.requestSubmit()}"></textarea><button class="btn btn-primary" type="submit" id="an-chat-enviar">Enviar</button></form>`;
    document.body.appendChild(panel);
    setTimeout(() => $('an-chat-input')?.focus(), 0);
  }
  const lista = $('an-chat-msjs');
  lista.innerHTML = anChat.mensajes.length
    ? anChat.mensajes.map(m => `<div class="an-msj ${m.de}${m.error ? ' error' : ''}">${m.de === 'bot' ? anTextoBot(m.texto) : esc(m.texto)}</div>`).join('') + (anChat.esperando ? '<div class="an-msj bot pensando">Mirando los números…</div>' : '')
    : `<p class="an-ayuda">Contesta con los números de esta pestaña, en vivo. Probá con:</p><div class="an-sugerencias">${AN_SUGERENCIAS.map(s => `<button type="button" onclick="preguntarAnalisis(null, this.textContent)">${esc(s)}</button>`).join('')}</div>`;
  lista.scrollTop = lista.scrollHeight;
  const enviar = $('an-chat-enviar');
  if (enviar) enviar.disabled = anChat.esperando;
}

function nuevaCharlaAnalisis() {
  anChat.charla = anNuevaCharlaId(); anChat.mensajes = []; anChat.esperando = false;
  anGuardarChat(); dibujarChatAnalisis();
}

async function preguntarAnalisis(ev, texto) {
  ev?.preventDefault();
  const input = $('an-chat-input');
  const pregunta = (texto || input?.value || '').trim();
  if (!pregunta || anChat.esperando) return;
  if (input) input.value = '';
  anChat.mensajes.push({ de: 'yo', texto: pregunta });
  anChat.esperando = true; anGuardarChat(); dibujarChatAnalisis();
  try {
    const r = await api('/api/analisis/preguntar', { method: 'POST', body: JSON.stringify({ pregunta, charla: anChat.charla }) });
    anChat.mensajes.push({ de: 'bot', texto: r.respuesta });
  } catch (err) {
    anChat.mensajes.push({ de: 'bot', texto: err.message || 'No se pudo contestar.', error: true });
  } finally {
    anChat.esperando = false; anGuardarChat();
    if ($('an-chat')) dibujarChatAnalisis();
  }
}
