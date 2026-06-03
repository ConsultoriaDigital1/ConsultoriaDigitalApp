/**
 * Integracion con Google Calendar via Service Account.
 *
 * No usa dependencias externas: firma un JWT (RS256) con `crypto`, lo intercambia
 * por un access token OAuth2 y llama a la API REST de Calendar v3 con fetch.
 *
 * Configuracion (ver GOOGLE_CALENDAR_SETUP.md):
 *   - GOOGLE_SERVICE_ACCOUNT_JSON : el JSON de la service account en una sola linea, o
 *   - GOOGLE_SERVICE_ACCOUNT_FILE : ruta al archivo .json de la service account.
 */
const crypto = require('crypto');
const fs = require('fs');

const TOKEN_SCOPE = 'https://www.googleapis.com/auth/calendar';
const API_BASE = 'https://www.googleapis.com/calendar/v3';

let _credentials = null; // null = sin cargar | false = no configurado | objeto = ok
let _tokenCache = { token: '', exp: 0 };

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function loadCredentials() {
  if (_credentials !== null) return _credentials;
  let raw = '';
  const inline = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  const file = (process.env.GOOGLE_SERVICE_ACCOUNT_FILE || '').trim();
  if (inline) {
    raw = inline;
  } else if (file) {
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_e) { raw = ''; }
  }
  if (!raw) { _credentials = false; return _credentials; }
  try {
    const json = JSON.parse(raw);
    if (!json.client_email || !json.private_key) { _credentials = false; return _credentials; }
    _credentials = {
      clientEmail: json.client_email,
      privateKey: String(json.private_key).replace(/\\n/g, '\n'),
      tokenUri: json.token_uri || 'https://oauth2.googleapis.com/token',
    };
  } catch (_e) {
    _credentials = false;
  }
  return _credentials;
}

function isConfigured() {
  return !!loadCredentials();
}

function serviceAccountEmail() {
  const creds = loadCredentials();
  return creds ? creds.clientEmail : '';
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function getAccessToken() {
  const creds = loadCredentials();
  if (!creds) throw httpError(503, 'Google Calendar no esta configurado en el servidor.');

  const now = Math.floor(Date.now() / 1000);
  if (_tokenCache.token && _tokenCache.exp - 60 > now) return _tokenCache.token;

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: creds.clientEmail,
    scope: TOKEN_SCOPE,
    aud: creds.tokenUri,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claim}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(creds.privateKey)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch(creds.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw httpError(502, `No se pudo autenticar con Google: ${detail}`);
  }
  _tokenCache = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return _tokenCache.token;
}

async function gcalFetch(pathname, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(API_BASE + pathname, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || `Error de Google Calendar (HTTP ${res.status}).`;
    throw httpError(res.status === 404 ? 404 : 502, msg);
  }
  return data;
}

async function listEvents(calendarId, timeMin, timeMax) {
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '2500',
  });
  const data = await gcalFetch(`/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`);
  return data.items || [];
}

async function createEvent(calendarId, resource) {
  return gcalFetch(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    body: JSON.stringify(resource),
  });
}

async function updateEvent(calendarId, eventId, resource) {
  return gcalFetch(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    body: JSON.stringify(resource),
  });
}

async function deleteEvent(calendarId, eventId) {
  const token = await getAccessToken();
  const res = await fetch(
    `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
  );
  // 410 Gone / 404 = ya no existe: lo tratamos como exito idempotente.
  if (!res.ok && res.status !== 410 && res.status !== 404) {
    throw httpError(502, `No se pudo eliminar el evento en Google Calendar (HTTP ${res.status}).`);
  }
}

module.exports = {
  isConfigured,
  serviceAccountEmail,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
};
