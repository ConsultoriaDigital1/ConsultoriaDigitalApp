// Marketing y accesos compartidos. Las contraseñas se piden únicamente al revelarlas.
let workspaceEntries = [];
let workspaceKind = '';
let workspaceRequest = 0;
let workspaceWeek = 0;
let workspaceEditing = '';
const workspaceFilters = {};
const WORKSPACE_CHANNELS = { redes: 'Redes sociales', pauta: 'Pauta publicitaria', web: 'Página web', whatsapp: 'Difusiones de WhatsApp' };
const WORKSPACE_STATUS = { pendiente: 'Pendiente', en_proceso: 'En proceso', completado: 'Completado' };

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
    root.innerHTML = `<div class="ws-toolbar"><label>Cliente <select id="ws-client-filter" onchange="renderWorkspaceContent()"><option value="">Todos los clientes</option>${workspaceClients(kind).map(c => `<option value="${esc(c.id)}" ${c.id === workspaceFilters[kind] ? 'selected' : ''}>${esc(c.nf || c.rs || 'Cliente')}</option>`).join('')}</select></label><button class="btn btn-primary" onclick="openWorkspaceEditor()">+ ${kind === 'cronograma' ? 'Nueva tarea' : kind === 'estadisticas' ? 'Nuevas estadísticas' : 'Nuevo acceso'}</button>${kind === 'estadisticas' ? '<button class="btn btn-ghost" onclick="exportWorkspaceReport()">Exportar reporte</button>' : ''}</div>${kind === 'estadisticas' ? '<div class="ws-toolbar"><label>Desde <input id="ws-period-start" type="date" onchange="renderWorkspaceContent()"></label><label>Hasta <input id="ws-period-end" type="date" onchange="renderWorkspaceContent()"></label></div>' : ''}<div id="ws-editor"></div><div id="ws-content"></div>`;
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
    const clients = workspaceClients().filter(c => !$('ws-client-filter').value || c.id === $('ws-client-filter').value);
    $('ws-content').innerHTML = `<div class="ws-toolbar"><button class="btn btn-ghost" onclick="workspaceWeek--;renderWorkspaceContent()" aria-label="Semana anterior">‹</button><strong>${days[0].split('-').reverse().join('/')} — ${days[6].split('-').reverse().join('/')}</strong><button class="btn btn-ghost" onclick="workspaceWeek++;renderWorkspaceContent()" aria-label="Semana siguiente">›</button><button class="btn btn-ghost" onclick="workspaceWeek=0;renderWorkspaceContent()">Esta semana</button></div><div class="ws-schedule-scroll"><table class="ws-schedule"><thead><tr><th scope="col">Cliente</th>${days.map((date, i) => `<th scope="col">${['LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB', 'DOM'][i]} ${date.slice(8)}</th>`).join('')}</tr></thead><tbody>${clients.map(c => `<tr><th scope="row">${esc(c.nf || c.rs || 'Cliente')}</th>${days.map(date => `<td><button class="btn btn-ghost btn-sm" aria-label="Agregar tarea el ${date} para ${esc(c.nf || c.rs || 'Cliente')}" data-client="${esc(c.id)}" onclick="openWorkspaceEditor('', '${date}', this.dataset.client)">+</button>${entries.filter(e => e.cardId === c.id && e.data.date === date).map(e => workspaceEntryHTML(e)).join('')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${clients.length ? '' : '<p class="ws-empty">Primero agregá clientes en Checklist.</p>'}`;
    return;
  }
  $('ws-content').innerHTML = entries.length ? `<div class="ws-entry-grid">${entries.map(workspaceEntryHTML).join('')}</div>` : '<p class="ws-empty">Todavía no hay registros para estos clientes.</p>';
}

function workspaceEntryHTML(entry) {
  const d = entry.data;
  // IDs se generan en el servidor; encodeURIComponent evita interpolar datos en JavaScript.
  const id = encodeURIComponent(entry.id);
  let body = '';
  if (entry.kind === 'cronograma') body = `<h3>${esc(d.title)}</h3><span class="ws-badge">${esc(WORKSPACE_STATUS[d.status])}</span><p>${esc(d.owner || 'Sin responsable')}</p><p class="ws-pre">${esc(d.notes)}</p>`;
  if (entry.kind === 'estadisticas') body = `<h3>${esc(WORKSPACE_CHANNELS[d.channel])}</h3><p>${esc(d.start)} al ${esc(d.end)}</p><dl>${d.metrics.map(m => `<div><dt>${esc(m.label)}</dt><dd>${esc(m.value)}</dd></div>`).join('')}</dl><p class="ws-pre">${esc(d.notes)}</p>`;
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
  const field = (name, label, type = 'text', value = '', required = true) => `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${required ? 'required' : ''} maxlength="${name === 'password' ? 4000 : 2000}"></label>`;
  const select = (name, label, options, value) => `<label>${label}<select name="${name}">${Object.entries(options).map(([key, title]) => `<option value="${esc(key)}" ${key === value ? 'selected' : ''}>${esc(title)}</option>`).join('')}</select></label>`;
  const today = workspaceDate(new Date());
  let fields = '';
  if (workspaceKind === 'cronograma') fields = field('title', 'Tarea / publicación', 'text', d.title) + field('date', 'Fecha', 'date', d.date || date || today) + select('owner', 'Responsable', { '': 'Sin responsable', ...Object.fromEntries(usersCache.filter(u => u.equipo === 'marketing').map(u => [u.nombre + ' ' + (u.apellido || ''), u.nombre + ' ' + (u.apellido || '')])) }, d.owner) + select('status', 'Estado', WORKSPACE_STATUS, d.status || 'pendiente');
  if (workspaceKind === 'estadisticas') fields = select('channel', 'Canal', WORKSPACE_CHANNELS, d.channel || 'redes') + field('start', 'Desde', 'date', d.start || today) + field('end', 'Hasta', 'date', d.end || today) + `<label class="ws-full">Métricas (una por línea: nombre = valor)<textarea name="metrics" rows="5" required placeholder="Alcance = 12000&#10;Interacciones = 850&#10;Consultas = 36">${esc(d.metrics?.map(m => m.label + ' = ' + m.value).join('\n') || '')}</textarea></label>`;
  if (workspaceKind === 'credenciales') fields = `<label>Plataforma<input name="platform" list="ws-platforms" value="${esc(d.platform)}" required maxlength="2000"><datalist id="ws-platforms">${['Facebook', 'Instagram', 'TikTok', 'Mail', 'Kommo', 'Hosting', 'WordPress', 'Dominio', 'GitHub'].map(p => `<option value="${p}">`).join('')}</datalist></label>` + field('username', 'Usuario / correo', 'text', d.username) + field('password', entry ? 'Nueva contraseña (vacío conserva la actual)' : 'Contraseña', 'password', '', !entry) + field('url', 'URL de acceso', 'url', d.url, false);
  $('ws-editor').innerHTML = `<form class="ws-form" onsubmit="saveWorkspaceEntry(event)"><h3 class="ws-full">${entry ? 'Editar registro' : 'Nuevo registro'}</h3><label class="ws-full">Cliente<select name="cardId" ${entry ? 'disabled' : ''}>${clients.map(c => `<option value="${esc(c.id)}" ${c.id === (entry?.cardId || clientId || $('ws-client-filter').value) ? 'selected' : ''}>${esc(c.nf || c.rs || 'Cliente')}</option>`).join('')}</select></label>${fields}<label class="ws-full">${workspaceKind === 'estadisticas' ? 'Análisis y próximos pasos' : 'Notas'}<textarea name="notes" maxlength="${workspaceKind === 'estadisticas' ? 8000 : 2000}" rows="3">${esc(d.notes)}</textarea></label><div class="ws-actions ws-full"><button class="btn btn-primary" type="submit">Guardar</button><button class="btn btn-ghost" type="button" onclick="closeWorkspaceEditor()">Cancelar</button></div></form>`;
  $('ws-editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function closeWorkspaceEditor() { if ($('ws-editor')) $('ws-editor').innerHTML = ''; workspaceEditing = ''; }

async function saveWorkspaceEntry(event) {
  event.preventDefault();
  const form = event.target, submit = form.querySelector('[type="submit"]');
  const values = Object.fromEntries(new FormData(form));
  const cardId = values.cardId;
  delete values.cardId;
  if (workspaceKind === 'estadisticas') {
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
  popup.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Reporte — ${esc(workspaceClientName(client))}</title><style>body{font:16px system-ui;color:#182431;max-width:850px;margin:45px auto;padding:0 24px}h1{font-size:32px}article{border-top:2px solid #ddd;padding:20px 0;break-inside:avoid}dl div{display:flex;justify-content:space-between;border-bottom:1px solid #eee;padding:8px}dd{font-weight:bold}p{white-space:pre-wrap}button{padding:12px;cursor:pointer}@media print{button{display:none}body{margin:0}}</style></head><body><button onclick="window.print()">Imprimir / Guardar como PDF</button><p>CONSULTORÍA DIGITAL · REPORTE DE RESULTADOS</p><h1>${esc(workspaceClientName(client))}</h1>${[...entries].sort((a, b) => a.data.start.localeCompare(b.data.start) || a.data.channel.localeCompare(b.data.channel)).map(e => `<article><h2>${esc(WORKSPACE_CHANNELS[e.data.channel])}</h2><p>Período: ${esc(e.data.start)} al ${esc(e.data.end)}</p><dl>${e.data.metrics.map(m => `<div><dt>${esc(m.label)}</dt><dd>${esc(m.value)}</dd></div>`).join('')}</dl><p>${esc(e.data.notes)}</p></article>`).join('')}</body></html>`);
  popup.document.close();
}
