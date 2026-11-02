// Marketing y accesos compartidos. Las contraseñas se piden únicamente al revelarlas.
let workspaceEntries = [];
let workspaceKind = '';
let workspaceRequest = 0;
let workspaceWeek = 0;
let workspaceEditing = '';
const workspaceFilters = {};
const WORKSPACE_CHANNELS = { redes: 'Redes sociales', pauta: 'Pauta publicitaria', web: 'Página web', whatsapp: 'Difusiones de WhatsApp' };
const WORKSPACE_STATUS = { programado: 'Programado', publicado: 'Publicado', cancelado: 'Cancelado' };
const MONTHLY_FIELDS = {
  pauta: { title: 'Resultados de pauta', fields: [['messages', 'Mensajes'], ['reach', 'Alcance'], ['impressions', 'Impresiones'], ['bestAd', 'Mejor anuncio', 'text']] },
  instagram: { title: 'Resultados de Instagram', fields: [['views', 'Visualizaciones'], ['followers', 'Seguidores al cierre'], ['interactions', 'Interacciones']] },
  web: { title: 'Resultados de página web', fields: [['visits', 'Visitas'], ['newUsers', 'Usuarios nuevos'], ['topPage', 'Página más visitada', 'text'], ['audience', 'Público', 'text'], ['device', 'Dispositivo principal', 'text']] },
  mail: { title: 'Resultados de mail', fields: [['sent', 'Cantidad de envíos'], ['users', 'Usuarios alcanzados'], ['opened', 'Aperturas']] },
  whatsapp: { title: 'Resultados de difusiones de WhatsApp', fields: [['sent', 'Cantidad de envíos'], ['users', 'Usuarios alcanzados'], ['opened', 'Lecturas']] },
};

function monthlyPreviousMonth(month) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 2, 1)).toISOString().slice(0, 7);
}

function monthlyChange(value, previous) {
  if (previous == null) return 'Sin datos del mes anterior';
  const current = Number(value), baseline = Number(previous);
  if (!baseline) return current === 0 ? '0% vs. mes anterior' : 'Sin base de comparación (mes anterior: 0)';
  const change = (current - baseline) / baseline * 100;
  return (change > 0 ? '+' : '') + change.toLocaleString('es-AR', { maximumFractionDigits: 1 }) + '% vs. mes anterior';
}

function monthlyReportHTML(entry) {
  const d = entry.data;
  const previous = workspaceEntries.find(e => e.cardId === entry.cardId && e.data.format === 'monthly' && e.data.month === monthlyPreviousMonth(d.month));
  return `<h3>Resultados mensuales · ${esc(d.month.split('-').reverse().join('/'))}</h3><p>Pauta activa: <strong>${d.adsActive ? 'Sí' : 'No'}</strong></p><div class="ws-results">${Object.entries(MONTHLY_FIELDS).filter(([key]) => d.sections[key]).map(([channel, group]) => `<section class="ws-result-section"><h4>${group.title}</h4><dl>${group.fields.filter(([key, , type]) => type !== 'text' || d.sections[channel][key]).map(([key, label, type]) => `<div><dt>${label}</dt><dd>${esc(d.sections[channel][key])}${type === 'text' ? '' : `<small class="ws-comparison">${esc(monthlyChange(d.sections[channel][key], previous?.data.sections[channel]?.[key]))}</small>`}</dd></div>`).join('')}</dl></section>`).join('')}</div><p class="ws-pre">${esc(d.notes)}</p>`;
}

function toggleMonthlySection(channel, enabled) {
  const fieldset = $('ws-monthly-' + channel);
  fieldset.hidden = !enabled;
  fieldset.disabled = !enabled;
}

function openMonthlyWorkspaceEditor(entry, clients) {
  const d = entry?.data || {};
  const currentMonth = new Date().toLocaleDateString('sv-SE').slice(0, 7);
  $('ws-schedule-editor').innerHTML = `<form class="ws-form ws-monthly-form" data-format="monthly" onsubmit="saveWorkspaceEntry(event)"><h3 class="ws-full" id="ws-editor-title">${entry ? 'Editar reporte mensual' : 'Nuevo reporte mensual'}</h3><label>Cliente<select name="cardId" ${entry ? 'disabled' : ''}>${clients.map(c => `<option value="${esc(c.id)}" ${c.id === (entry?.cardId || $('ws-client-filter').value) ? 'selected' : ''}>${esc(c.nf || c.rs || 'Cliente')}</option>`).join('')}</select></label><label>Mes del reporte<input name="month" type="month" value="${esc(d.month || currentMonth)}" min="2000-01" max="2100-12" required></label><fieldset class="ws-full ws-ads-toggle"><legend>¿Tuvo pauta activa?</legend><label><input type="radio" name="adsActive" value="yes" ${d.adsActive ? 'checked' : ''} onchange="toggleMonthlySection('pauta', true)" required> Sí</label><label><input type="radio" name="adsActive" value="no" ${d.adsActive ? '' : 'checked'} onchange="toggleMonthlySection('pauta', false)"> No</label></fieldset>${Object.entries(MONTHLY_FIELDS).map(([channel, group]) => {
    const enabled = channel === 'pauta' ? !!d.adsActive : entry ? !!d.sections[channel] : channel === 'instagram';
    return `${channel === 'pauta' ? '' : `<label class="ws-full ws-channel-toggle"><input type="checkbox" ${enabled ? 'checked' : ''} onchange="toggleMonthlySection('${channel}', this.checked)"> Incluir ${group.title.replace('Resultados de ', '')}</label>`}<fieldset id="ws-monthly-${channel}" class="ws-full ws-monthly-section" ${enabled ? '' : 'hidden disabled'}><legend>${group.title}</legend>${group.fields.map(([key, label, type]) => `<label>${label}<input name="${channel}.${key}" type="${type || 'number'}" value="${esc(d.sections?.[channel]?.[key] ?? '')}" ${type === 'text' ? 'maxlength="200"' : 'min="0" max="9007199254740991" step="1" required'}></label>`).join('')}</fieldset>`;
  }).join('')}<p class="ws-full ws-monthly-help">Una carga por cliente y mes. Las variaciones se calculan con el mes anterior cuando hay datos disponibles.</p><label class="ws-full">Análisis y próximos pasos<textarea name="notes" rows="3" maxlength="8000">${esc(d.notes)}</textarea></label><div class="ws-actions ws-full"><button type="submit" class="btn btn-primary">Guardar resultados</button><button type="button" class="btn btn-ghost" onclick="closeWorkspaceEditor()">Cancelar</button></div></form>`;
  showWorkspaceDialog('[name="month"]');
}

function workspaceAllowed(tab) {
  if (tab === 'credenciales') return isAdmin() || ['marketing', 'desarrollo'].includes(currentUser?.equipo);
  return isAdmin() || currentUser?.equipo === 'marketing';
}

function syncWorkspaceNav() {
  ['inicio', 'cronograma', 'estadisticas', 'credenciales'].forEach(tab => {
    document.querySelectorAll(`[data-tab="${tab}"]`).forEach(el => { el.style.display = workspaceAllowed(tab) ? '' : 'none'; });
  });
  document.querySelectorAll('[data-tab="clientes"]').forEach(el => {
    const label = currentUser?.equipo === 'marketing' ? 'Checklist' : 'Clientes';
    const span = el.querySelector('span');
    if (span) span.textContent = label; else el.textContent = label.toUpperCase();
  });
}

function clearWorkspace() {
  closeWorkspaceEditor();
  workspaceRequest++;
  workspaceEntries = [];
  workspaceEditing = '';
  ['cronograma', 'estadisticas', 'credenciales'].forEach(kind => { $('workspace-' + kind).innerHTML = ''; });
}

function renderMarketingHome() {
  const options = [
    ['calendario', '01', 'Calendario', 'Reuniones, eventos y fechas importantes'],
    ['cronograma', '02', 'Cronograma', 'Organizá las tareas y publicaciones de la semana'],
    ['clientes', '03', 'Checklist', 'Clientes, pendientes y seguimiento del trabajo'],
    ['estadisticas', '04', 'Estadísticas', 'Resultados por canal y reportes para clientes'],
    ['credenciales', '05', 'Credenciales', 'Accesos de cada cliente en un solo lugar'],
    ['talentos', '06', 'Equipo', 'Conocé a las personas de tu equipo'],
  ];
  $('marketing-home').innerHTML = `<div class="ws-welcome"><span class="ws-eyebrow">EQUIPO DE MARKETING</span><h1>Hola, ${esc(currentUser.nombre)} 👋</h1><p>¿A qué opción querés ir hoy?</p></div><div class="ws-home-grid">${options.map(([tab, n, title, sub]) => `<button class="ws-home-card" onclick="switchTab('${tab}')"><span class="ws-number">${n}</span><strong>${title}</strong><span>${sub}</span><b aria-hidden="true">↗</b></button>`).join('')}</div>`;
}

function workspaceClients(kind = workspaceKind) {
  return cardsCache.filter(c => (activeTeam === 'all' || c.equipo === activeTeam) && (kind === 'credenciales' ? ['marketing', 'desarrollo'].includes(c.equipo) : c.equipo === 'marketing'));
}
function workspaceClientName(id) {
  const card = cardsCache.find(c => c.id === id);
  return card?.nf || card?.rs || 'Cliente';
}
function workspaceVisibleEntries() {
  const ids = new Set(workspaceClients().map(c => c.id));
  const client = $('ws-client-filter')?.value;
  const start = $('ws-period-start')?.value, end = $('ws-period-end')?.value;
  return workspaceEntries.filter(e => ids.has(e.cardId) && (!client || e.cardId === client) && (!start || e.data.start >= start) && (!end || e.data.end <= end));
}
function workspaceDate(date) { return date.toISOString().slice(0, 10); }
function workspaceMonday() {
  const now = new Date();
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) + workspaceWeek * 7);
  return date;
}

async function renderWorkspace(kind) {
  if (workspaceKind === kind && $('ws-client-filter')) workspaceFilters[kind] = $('ws-client-filter').value;
  clearWorkspace();
  const request = ++workspaceRequest;
  workspaceKind = kind;
  workspaceEntries = [];
  workspaceEditing = '';
  const root = $('workspace-' + kind);
  root.innerHTML = '<p class="ws-empty">Cargando…</p>';
  try {
    const result = await api('/api/workspace/' + kind);
    if (request !== workspaceRequest || activeTab !== kind) return;
    workspaceEntries = result.entries;
    root.innerHTML = `<div class="ws-toolbar"><label>Cliente <select id="ws-client-filter" onchange="renderWorkspaceContent()"><option value="">Todos los clientes</option>${workspaceClients(kind).map(c => `<option value="${esc(c.id)}" ${c.id === workspaceFilters[kind] ? 'selected' : ''}>${esc(c.nf || c.rs || 'Cliente')}</option>`).join('')}</select></label><button class="btn btn-primary" onclick="openWorkspaceEditor()">+ ${kind === 'cronograma' ? 'Nueva tarea' : kind === 'estadisticas' ? 'Nuevo reporte mensual' : 'Nuevo acceso'}</button>${kind === 'estadisticas' ? '<button class="btn btn-ghost" onclick="exportWorkspaceReport()">Exportar reporte</button>' : ''}</div>${kind === 'estadisticas' ? '<div class="ws-toolbar"><label>Desde <input id="ws-period-start" type="date" onchange="renderWorkspaceContent()"></label><label>Hasta <input id="ws-period-end" type="date" onchange="renderWorkspaceContent()"></label></div>' : ''}<div id="ws-editor"></div><div id="ws-content"></div>`;
    renderWorkspaceContent();
  } catch (err) {
    if (request === workspaceRequest) { root.innerHTML = '<p class="ws-empty">No se pudo cargar la sección. Volvé a ingresar para reintentar.</p>'; toast(err.message, 'error'); }
  }
}

function renderWorkspaceContent() {
  closeWorkspaceEditor();
  workspaceFilters[workspaceKind] = $('ws-client-filter').value;
  const entries = workspaceVisibleEntries();
  if (workspaceKind === 'cronograma') {
    const monday = workspaceMonday();
    const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setUTCDate(d.getUTCDate() + i); return workspaceDate(d); });
    $('ws-content').innerHTML = `<div class="ws-toolbar"><button class="btn btn-ghost" onclick="workspaceWeek--;renderWorkspaceContent()" aria-label="Semana anterior">‹</button><strong>${days[0].split('-').reverse().join('/')} — ${days[6].split('-').reverse().join('/')}</strong><button class="btn btn-ghost" onclick="workspaceWeek++;renderWorkspaceContent()" aria-label="Semana siguiente">›</button><button class="btn btn-ghost" onclick="workspaceWeek=0;renderWorkspaceContent()">Esta semana</button></div><div class="ws-schedule-scroll"><table class="ws-schedule"><thead><tr>${days.map((date, i) => `<th scope="col"><div class="ws-day-heading"><span>${['LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB', 'DOM'][i]} ${date.slice(8)}</span><button class="btn btn-ghost btn-sm" aria-label="Agregar tarea el ${date}" onclick="openWorkspaceEditor('', '${date}')">+</button></div></th>`).join('')}</tr></thead><tbody><tr>${days.map(date => {
      const tasks = entries.filter(e => e.data.date === date);
      const clients = [...new Set(tasks.map(e => e.cardId))];
      return `<td>${clients.map(cardId => `<section class="ws-day-client"><h3>${esc(workspaceClientName(cardId))}</h3><div class="ws-day-tasks">${tasks.filter(e => e.cardId === cardId).map(workspaceEntryHTML).join('')}</div></section>`).join('') || '<p class="ws-day-empty">Sin tareas</p>'}</td>`;
    }).join('')}</tr></tbody></table></div>`;
    return;
  }
  $('ws-content').innerHTML = entries.length ? `<div class="ws-entry-grid${workspaceKind === 'estadisticas' ? ' ws-monthly-grid' : ''}">${entries.map(workspaceEntryHTML).join('')}</div>` : '<p class="ws-empty">Todavía no hay registros para estos clientes.</p>';
}

function workspaceEntryHTML(entry) {
  const d = entry.data;
  // IDs se generan en el servidor; encodeURIComponent evita interpolar datos en JavaScript.
  const id = encodeURIComponent(entry.id);
  let body = '';
  if (entry.kind === 'cronograma') return `<article class="ws-schedule-task"><button class="ws-task-edit" onclick="openWorkspaceEditor('${id}')" title="${esc([d.title, d.owner, d.notes].filter(Boolean).join(' · '))}"><span class="ws-task-title">${esc(d.title)}</span><span class="ws-badge ws-status-${esc(d.status)}">${esc(WORKSPACE_STATUS[d.status])}</span></button><button class="ws-task-delete" onclick="deleteWorkspaceEntry('${id}')" aria-label="Eliminar ${esc(d.title)}">×</button></article>`;
  if (entry.kind === 'estadisticas') body = d.format === 'monthly' ? monthlyReportHTML(entry) : `<h3>${esc(WORKSPACE_CHANNELS[d.channel])}</h3><p>${esc(d.start)} al ${esc(d.end)}</p><dl>${d.metrics.map(m => `<div><dt>${esc(m.label)}</dt><dd>${esc(m.value)}</dd></div>`).join('')}</dl><p class="ws-pre">${esc(d.notes)}</p>`;
  if (entry.kind === 'credenciales') body = `<h3>${esc(d.platform)}</h3><p class="ws-pre">${esc(d.username)}</p>${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">Abrir plataforma ↗</a>` : ''}<div class="ws-secret"><input type="password" readonly value="••••••••" aria-label="Contraseña" autocomplete="off"><button class="btn btn-ghost btn-sm" onclick="revealWorkspacePassword('${id}', this)">Mostrar</button></div><p class="ws-pre">${esc(d.notes)}</p>`;
  return `<article class="ws-entry"><span class="ws-eyebrow">${esc(workspaceClientName(entry.cardId))}</span>${body}<div class="ws-actions"><button class="btn btn-ghost btn-sm" onclick="openWorkspaceEditor('${id}')">Editar</button><button class="btn btn-ghost btn-sm" onclick="deleteWorkspaceEntry('${id}')">Eliminar</button></div></article>`;
}

function openWorkspaceEditor(id = '', date = '', clientId = '') {
  id = decodeURIComponent(id);
  const entry = workspaceEntries.find(e => e.id === id);
  const d = entry?.data || {};
  const clients = workspaceClients();
  if (!clients.length) { toast('Primero creá un cliente en Checklist / Clientes.', 'error'); return; }
  workspaceEditing = id;
  if (workspaceKind === 'estadisticas' && (!entry || d.format === 'monthly')) { openMonthlyWorkspaceEditor(entry, clients); return; }
  const field = (name, label, type = 'text', value = '', required = true) => `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${required ? 'required' : ''} maxlength="${name === 'password' ? 4000 : 2000}"></label>`;
  const select = (name, label, options, value) => `<label>${label}<select name="${name}">${Object.entries(options).map(([key, title]) => `<option value="${esc(key)}" ${key === value ? 'selected' : ''}>${esc(title)}</option>`).join('')}</select></label>`;
  const today = workspaceDate(new Date());
  let fields = '';
  if (workspaceKind === 'cronograma') fields = field('title', 'Tarea / publicación', 'text', d.title) + field('date', 'Fecha', 'date', d.date || date || today) + select('owner', 'Responsable', { '': 'Sin responsable', ...(d.owner ? { [d.owner]: d.owner } : {}), ...Object.fromEntries(usersCache.filter(u => u.equipo === 'marketing').map(u => { const name = [u.nombre, u.apellido].filter(Boolean).join(' '); return [name, name]; })) }, d.owner) + select('status', 'Estado', WORKSPACE_STATUS, d.status || 'programado');
  if (workspaceKind === 'estadisticas') fields = select('channel', 'Canal', WORKSPACE_CHANNELS, d.channel || 'redes') + field('start', 'Desde', 'date', d.start || today) + field('end', 'Hasta', 'date', d.end || today) + `<label class="ws-full">Métricas (una por línea: nombre = valor)<textarea name="metrics" rows="5" required placeholder="Alcance = 12000&#10;Interacciones = 850&#10;Consultas = 36">${esc(d.metrics?.map(m => m.label + ' = ' + m.value).join('\n') || '')}</textarea></label>`;
  if (workspaceKind === 'credenciales') fields = `<label>Plataforma<input name="platform" list="ws-platforms" value="${esc(d.platform)}" required maxlength="2000"><datalist id="ws-platforms">${['Facebook', 'Instagram', 'TikTok', 'Mail', 'Kommo', 'Hosting', 'WordPress', 'Dominio', 'GitHub'].map(p => `<option value="${p}">`).join('')}</datalist></label>` + field('username', 'Usuario / correo', 'text', d.username) + field('password', entry ? 'Nueva contraseña (vacío conserva la actual)' : 'Contraseña', 'password', '', !entry) + field('url', 'URL de acceso', 'url', d.url, false);
  const target = $(workspaceKind === 'credenciales' ? 'ws-editor' : 'ws-schedule-editor');
  target.innerHTML = `<form class="ws-form" onsubmit="saveWorkspaceEntry(event)"><h3 class="ws-full" id="ws-editor-title">${entry ? 'Editar registro' : 'Nuevo registro'}</h3><label class="ws-full">Cliente<select name="cardId" ${entry ? 'disabled' : ''}>${clients.map(c => `<option value="${esc(c.id)}" ${c.id === (entry?.cardId || clientId || $('ws-client-filter').value) ? 'selected' : ''}>${esc(c.nf || c.rs || 'Cliente')}</option>`).join('')}</select></label>${fields}<label class="ws-full">${workspaceKind === 'estadisticas' ? 'Análisis y próximos pasos' : 'Notas'}<textarea name="notes" maxlength="${workspaceKind === 'estadisticas' ? 8000 : 2000}" rows="3">${esc(d.notes)}</textarea></label><div class="ws-actions ws-full"><button class="btn btn-primary" type="submit">Guardar</button><button class="btn btn-ghost" type="button" onclick="closeWorkspaceEditor()">Cancelar</button></div></form>`;
  if (workspaceKind !== 'credenciales') showWorkspaceDialog('[name="title"], [name="start"]');
  else target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function showWorkspaceDialog(focusSelector) {
  const dialog = $('ws-schedule-dialog');
  dialog.classList.toggle('ws-report-dialog', workspaceKind === 'estadisticas');
  enhanceDateTimeFields($('ws-schedule-editor'));
  dialog.showModal();
  dialog.querySelector(focusSelector)?.focus();
}
function closeWorkspaceEditor() {
  const dialog = $('ws-schedule-dialog');
  if (dialog?.open) dialog.close();
  if ($('ws-schedule-editor')) $('ws-schedule-editor').innerHTML = '';
  if ($('ws-editor')) $('ws-editor').innerHTML = '';
  workspaceEditing = '';
}

async function saveWorkspaceEntry(event) {
  event.preventDefault();
  const form = event.target, submit = form.querySelector('[type="submit"]');
  let values = Object.fromEntries(new FormData(form));
  const cardId = values.cardId;
  delete values.cardId;
  if (workspaceKind === 'estadisticas' && form.dataset.format === 'monthly') {
    const sections = {};
    for (const channel of Object.keys(MONTHLY_FIELDS)) {
      if (!$('ws-monthly-' + channel).disabled) sections[channel] = Object.fromEntries(MONTHLY_FIELDS[channel].fields.map(([key]) => [key, values[channel + '.' + key]]));
    }
    values = { format: 'monthly', month: values.month, adsActive: values.adsActive === 'yes', sections, notes: values.notes };
  } else if (workspaceKind === 'estadisticas') {
    const lines = values.metrics.split('\n').filter(line => line.trim());
    if (lines.some(line => line.indexOf('=') <= 0 || !line.slice(line.indexOf('=') + 1).trim())) { toast('Usá nombre = valor para cada métrica.', 'error'); return; }
    values.metrics = lines.map(line => ({ label: line.slice(0, line.indexOf('=')).trim(), value: line.slice(line.indexOf('=') + 1).trim() }));
  }
  submit.disabled = true;
  const kind = workspaceKind;
  try {
    await api(workspaceEditing ? '/api/workspace/entries/' + encodeURIComponent(workspaceEditing) : '/api/workspace/' + kind, { method: workspaceEditing ? 'PUT' : 'POST', body: JSON.stringify({ cardId, data: values }) });
    toast('Guardado');
    if (activeTab === kind) await renderWorkspace(kind);
  } catch (err) { toast(err.message, 'error'); submit.disabled = false; }
}

async function deleteWorkspaceEntry(id) {
  if (!confirm('¿Eliminar este registro?')) return;
  const kind = workspaceKind;
  try { await api('/api/workspace/entries/' + id, { method: 'DELETE' }); if (activeTab === kind) await renderWorkspace(kind); }
  catch (err) { toast(err.message, 'error'); }
}
async function revealWorkspacePassword(id, button) {
  const input = button.previousElementSibling;
  if (input.type === 'text') { input.type = 'password'; input.value = '••••••••'; button.textContent = 'Mostrar'; return; }
  button.disabled = true;
  try {
    const result = await api('/api/workspace/entries/' + id + '/reveal', { method: 'POST' });
    if (!button.isConnected) return;
    input.type = 'text'; input.value = result.password; button.textContent = 'Ocultar';
    setTimeout(() => { input.type = 'password'; input.value = '••••••••'; button.textContent = 'Mostrar'; }, 20000);
  } catch (err) { toast(err.message, 'error'); }
  finally { button.disabled = false; }
}

function exportWorkspaceReport() {
  const entries = workspaceVisibleEntries();
  const client = $('ws-client-filter').value;
  if (!client) { toast('Elegí un cliente para exportar su reporte.', 'error'); return; }
  if (!entries.length) { toast('Este cliente todavía no tiene estadísticas.', 'error'); return; }
  const popup = window.open('', '_blank');
  if (!popup) { toast('Permití abrir ventanas para exportar el reporte.', 'error'); return; }
  popup.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Reporte — ${esc(workspaceClientName(client))}</title><style>body{font:16px system-ui;color:#182431;max-width:850px;margin:45px auto;padding:0 24px}h1{font-size:32px}article{border-top:2px solid #ddd;padding:20px 0;break-inside:avoid}dl div{display:flex;justify-content:space-between;border-bottom:1px solid #eee;padding:8px}dd{font-weight:bold}.ws-comparison{display:block;font-size:11px;font-weight:normal;color:#596575;margin-top:4px}.ws-result-section{break-inside:avoid}p{white-space:pre-wrap}button{padding:12px;cursor:pointer}@media print{button{display:none}body{margin:0}}</style></head><body><button onclick="window.print()">Imprimir / Guardar como PDF</button><p>CONSULTORÍA DIGITAL · REPORTE DE RESULTADOS</p><h1>${esc(workspaceClientName(client))}</h1>${[...entries].sort((a, b) => a.data.start.localeCompare(b.data.start) || (a.data.channel || 'monthly').localeCompare(b.data.channel || 'monthly')).map(e => e.data.format === 'monthly' ? `<article>${monthlyReportHTML(e)}</article>` : `<article><h2>${esc(WORKSPACE_CHANNELS[e.data.channel])}</h2><p>Período: ${esc(e.data.start)} al ${esc(e.data.end)}</p><dl>${e.data.metrics.map(m => `<div><dt>${esc(m.label)}</dt><dd>${esc(m.value)}</dd></div>`).join('')}</dl><p>${esc(e.data.notes)}</p></article>`).join('')}</body></html>`);
  popup.document.close();
}
