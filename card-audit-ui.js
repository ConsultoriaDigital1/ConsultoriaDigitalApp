const CARD_AUDIT_ACTIONS = { create: 'Creación', move: 'Movimiento', edit: 'Edición', trash: 'Envío a papelera', restore: 'Restauración', delete: 'Eliminación definitiva', reorder: 'Cambio de orden', comment: 'Comentario' };
const CARD_AUDIT_FIELDS = { nf: 'Nombre del cliente', rs: 'Razón social', cuit: 'CUIT', ca: 'Contacto', ntel: 'Teléfono', t: 'Actividad', ta: 'Servicio', c: 'Descripción / comentarios', color: 'Color', estado: 'Estado', equipo: 'Equipo', usuario: 'Responsable', usuarios: 'Miembros', debe: 'Deuda', monto_deuda: 'Monto de deuda', vence: 'Vencimiento', vence_hora: 'Hora de vencimiento', cover_image: 'Portada', banner_image: 'Banner', checklist: 'Checklist', pauta_url: 'Enlace de pauta', attachments: 'Archivos', daily_check_date: 'Control diario', position: 'Posición', deleted_at: 'Papelera', whatsapp_lid_alias: 'Contacto de WhatsApp', comentario: 'Comentario' };
let cardAuditCursor = null;
let cardAuditTeam = '';
let cardAuditRequest = 0;
let cardAuditResource = 'card';
let cardAuditCardId = '';

function openCardAudit(cardId = '', resource = 'card') {
  cardAuditResource = resource;
  cardAuditCardId = cardId;
  cardAuditTeam = resource === 'estadisticas' ? 'marketing' : activeTab === 'ventas' ? 'ventas' : activeTeam;
  $('card-audit-title').textContent = resource === 'estadisticas' ? 'Trazabilidad de reportes' : 'Trazabilidad';
  $('card-audit-context').textContent = cardId ? workspaceClientName(cardId) : TEAMS[cardAuditTeam] || 'Mis equipos';
  $('card-audit-search').value = '';
  $('card-audit-action').innerHTML = '<option value="">Todas las acciones</option>' + Object.entries(CARD_AUDIT_ACTIONS).filter(([key]) => resource !== 'estadisticas' || ['create', 'edit', 'delete'].includes(key)).map(([key, title]) => `<option value="${key}">${title}</option>`).join('');
  $('card-audit-dialog').showModal();
  $('card-audit-search').focus();
  loadCardAudit();
}

function closeCardAudit() {
  cardAuditRequest++;
  if ($('card-audit-dialog').open) $('card-audit-dialog').close();
  $('card-audit-entries').innerHTML = '';
  $('card-audit-search').value = '';
  cardAuditCursor = null;
}

function cardAuditValue(field, value) {
  if (value == null || value === '') return '—';
  const userName = id => { const user = usersCache.find(u => u.id === id); return user ? [user.nombre, user.apellido].filter(Boolean).join(' ') : id; };
  if (field === 'equipo') return TEAMS[value] || value;
  if (field === 'estado') return STATUS_LABEL[value] || SALES_STATUS_LABEL[value] || value;
  if (field === 'usuario') return userName(value);
  if (field === 'cliente') return workspaceClientName(value);
  if (field === 'adsActive') return value ? 'Sí' : 'No';
  if (field === 'metrics' && Array.isArray(value)) return value.map(m => m.label + ': ' + m.value).join('\n');
  if (field === 'usuarios' && Array.isArray(value)) return value.map(userName).join(', ') || 'Sin miembros';
  if (field === 'checklist' && Array.isArray(value)) return value.map(item => `${item.done ? '✓' : item.progress ? '◷' : '○'} ${item.text}${item.usuario ? ' · ' + userName(item.usuario) : ''}`).join('\n') || 'Sin tareas';
  if (field === 'attachments' && Array.isArray(value)) return value.map(item => item.name || 'Archivo').join('\n') || 'Sin archivos';
  if (field === 'cover_image' || field === 'banner_image') return value.present ? 'Imagen cargada' : 'Sin imagen';
  if (field === 'deleted_at') return new Date(value).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}

function cardAuditFieldLabel(field) {
  const [channel, key] = field.split('.');
  if (key && MONTHLY_FIELDS[channel]) {
    const item = MONTHLY_FIELDS[channel].fields.find(([name]) => name === key);
    if (item) return MONTHLY_FIELDS[channel].title + ' · ' + item[1];
  }
  return ({ cliente: 'Cliente', month: 'Mes del reporte', start: 'Desde', end: 'Hasta', adsActive: 'Pauta activa', notes: 'Análisis y próximos pasos', channel: 'Canal', metrics: 'Métricas' })[field] || CARD_AUDIT_FIELDS[field] || field;
}

function cardAuditEntryHTML(entry) {
  const date = new Date(entry.occurredAt).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'medium' });
  const changes = Object.entries(entry.changes || {});
  return `<article class="audit-entry"><div class="audit-entry-head"><span class="ws-badge">${esc(CARD_AUDIT_ACTIONS[entry.action] || entry.action)}</span><time datetime="${esc(entry.occurredAt)}">${esc(date)}</time></div><h3>${esc(entry.cardName)}</h3><p><strong>${esc(entry.actor?.name || 'Sistema')}</strong>${entry.actor?.username ? ' · @' + esc(entry.actor.username) : ''}</p><details><summary>Ver cambios (${changes.length})</summary><div class="audit-changes">${changes.map(([field, change]) => `<section><h4>${esc(cardAuditFieldLabel(field))}</h4><div class="audit-change-values"><div><span>Antes</span><pre>${esc(cardAuditValue(field, change.before))}</pre></div><div><span>Después</span><pre>${esc(cardAuditValue(field, change.after))}</pre></div></div></section>`).join('')}</div></details></article>`;
}

async function loadCardAudit(reset = true) {
  const request = ++cardAuditRequest;
  const list = $('card-audit-entries'), more = $('card-audit-more');
  const params = new URLSearchParams({ team: cardAuditTeam, resource: cardAuditResource, q: $('card-audit-search').value.trim(), action: $('card-audit-action').value });
  if (cardAuditCardId) params.set('cardId', cardAuditCardId);
  if (!reset && cardAuditCursor) params.set('cursor', cardAuditCursor);
  if (reset) { cardAuditCursor = null; more.hidden = true; list.innerHTML = '<p class="ws-empty">Cargando historial…</p>'; }
  more.disabled = true;
  try {
    const result = await api('/api/card-audit?' + params);
    if (request !== cardAuditRequest || !$('card-audit-dialog').open) return;
    if (reset) list.innerHTML = '';
    list.insertAdjacentHTML('beforeend', result.entries.map(cardAuditEntryHTML).join(''));
    if (!list.children.length) list.innerHTML = '<p class="ws-empty">No hay movimientos registrados para estos filtros.</p>';
    cardAuditCursor = result.nextCursor;
    more.hidden = !cardAuditCursor;
  } catch (err) {
    if (request !== cardAuditRequest) return;
    if (reset) list.innerHTML = '<p class="ws-empty">No se pudo cargar el historial. Usá Buscar para reintentar.</p>';
    toast(err.message, 'error');
  } finally { if (request === cardAuditRequest) more.disabled = false; }
}
