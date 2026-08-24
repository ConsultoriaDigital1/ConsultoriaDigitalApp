// ─────────────────────────────────────────────────────────────────────────────
// Integración con ARCA (ex AFIP) — Factura electrónica
//   WSAA  : autenticación con certificado digital (CMS/PKCS#7 firmado)
//   WSFEv1: solicitud de CAE (FECAESolicitar) y último comprobante autorizado
// Sin SDKs externos: SOAP crudo sobre fetch + firma con node-forge.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const https = require('https');
const forge = require('node-forge');

function configFromEnv(prefix = 'ARCA') {
  const production = process.env[`${prefix}_PRODUCTION`] === 'true';
  return {
    id: prefix === 'ARCA' ? 'default' : prefix.replace(/^ARCA_/, '').toLowerCase(),
    cuit: String(process.env[`${prefix}_CUIT`] || '').replace(/\D/g, ''),
    production,
    certPath: process.env[`${prefix}_CERT_PATH`] || '',
    keyPath: process.env[`${prefix}_KEY_PATH`] || '',
    ptoVta: Number(process.env[`${prefix}_PTO_VTA`] || 1),
    wsaaUrl: production ? 'https://wsaa.afip.gov.ar/ws/services/LoginCms' : 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
    wsfeUrl: production ? 'https://servicios1.afip.gov.ar/wsfev1/service.asmx' : 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
    taCacheFile: path.join(__dirname, '.local', `arca-ta-${prefix.toLowerCase()}.json`),
  };
}

const DEFAULT_CONFIG = configFromEnv('ARCA');
const ACCOUNTS = { default: DEFAULT_CONFIG };
if (process.env.ARCA_COMYDES_CUIT || process.env.ARCA_COMYDES_CERT_PATH || process.env.ARCA_COMYDES_KEY_PATH) {
  ACCOUNTS.comydes = configFromEnv('ARCA_COMYDES');
}

function isConfigured(config = DEFAULT_CONFIG) {
  return Boolean(config.cuit && config.certPath && config.keyPath && fs.existsSync(config.certPath) && fs.existsSync(config.keyPath));
}

function status(config = DEFAULT_CONFIG) {
  return {
    id: config.id,
    configured: isConfigured(config),
    production: config.production,
    cuit: config.cuit,
    ptoVta: config.ptoVta,
  };
}

function accountsStatus() {
  return Object.fromEntries(Object.entries(ACCOUNTS).map(([id, config]) => [id, status(config)]));
}

// ── helpers XML (las respuestas de ARCA son acotadas y predecibles) ──
function xmlVal(xml, tag) {
  // El nombre del tag tiene que terminar acá: si no, buscar <FchVto> matchearía
  // <FchVtoPago>, y <CAE> matchearía <CAEFchVto>.
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : '';
}

function xmlUnescape(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Los servidores de ARCA ofrecen por defecto un cipher DHE con una clave más chica
// de lo que acepta OpenSSL 3 (ERR_SSL_DH_KEY_TOO_SMALL) y el handshake se corta antes
// de mandar nada. Forzamos ECDHE, que soportan los cuatro endpoints (producción y
// homologación) y además mantiene forward secrecy. Por eso va https en vez de fetch:
// fetch no permite tocar los ciphers del socket.
const SOAP_TIMEOUT_MS = 30000;
const arcaAgent = new https.Agent({ keepAlive: true, ciphers: 'ECDHE:DEFAULT:!DHE' });

// Esperas entre reintentos de errores de transporte.
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Marca un error como "no llegó a procesarse" (red, TLS, timeout, 5xx). Sólo estos
// se reintentan: un rechazo de ARCA por datos da siempre el mismo resultado.
function retryable(err) {
  err.arcaRetryable = true;
  return err;
}

/**
 * Reintenta con backoff, pero SÓLO errores de transporte.
 * Usar únicamente en llamadas idempotentes (consultas, login): reintentar
 * FECAESolicitar a ciegas puede emitir la misma factura dos veces.
 */
async function withRetry(fn, reintentos = RETRY_DELAYS_MS.length) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!err.arcaRetryable || i >= reintentos) throw err;
      await sleep(RETRY_DELAYS_MS[Math.min(i, RETRY_DELAYS_MS.length - 1)]);
    }
  }
}

function soapPost(url, action, body) {
  const { hostname, pathname, search } = new URL(url);
  const payload = Buffer.from(body, 'utf8');
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        agent: arcaAgent,
        hostname,
        path: pathname + search,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'Content-Length': payload.length,
          // WSAA exige el header SOAPAction presente aunque sea vacío ("no SOAPAction header!")
          SOAPAction: action || '',
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const fault = xmlVal(text, 'faultstring') || text.slice(0, 300);
            const err = new Error(`ARCA respondió ${res.statusCode}: ${fault}`);
            // 5xx = problema del lado de ARCA, puede andar en el próximo intento.
            reject(res.statusCode >= 500 ? retryable(err) : err);
            return;
          }
          resolve(text);
        });
      }
    );
    req.setTimeout(SOAP_TIMEOUT_MS, () => {
      req.destroy(retryable(new Error('ARCA no respondió a tiempo (timeout).')));
    });
    // Cualquier fallo de socket/TLS/DNS: la request no llegó a destino.
    req.on('error', (err) => reject(retryable(err)));
    req.end(payload);
  });
}

// ── WSAA: obtener token + sign ──
function buildTRA() {
  const now = Date.now();
  const fmt = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '-00:00');
  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${Math.floor(now / 1000)}</uniqueId>
    <generationTime>${fmt(now - 10 * 60 * 1000)}</generationTime>
    <expirationTime>${fmt(now + 12 * 60 * 60 * 1000)}</expirationTime>
  </header>
  <service>wsfe</service>
</loginTicketRequest>`;
}

function signTRA(tra, config = DEFAULT_CONFIG) {
  const certPem = fs.readFileSync(config.certPath, 'utf8');
  const keyPem = fs.readFileSync(config.keyPath, 'utf8');
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, 'utf8');
  const cert = forge.pki.certificateFromPem(certPem);
  p7.addCertificate(cert);
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(keyPem),
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

function readCachedTA(config = DEFAULT_CONFIG) {
  try {
    const ta = JSON.parse(fs.readFileSync(config.taCacheFile, 'utf8'));
    // margen de 5 minutos antes del vencimiento
    if (ta && ta.production === config.production && ta.cuit === config.cuit && Date.parse(ta.expiration) - Date.now() > 5 * 60 * 1000) {
      return ta;
    }
  } catch (_e) { /* sin cache */ }
  return null;
}

async function getTA(config = DEFAULT_CONFIG) {
  const cached = readCachedTA(config);
  if (cached) return cached;

  const cms = signTRA(buildTRA(), config);
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Body>
    <wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;

  const resXml = await withRetry(() => soapPost(config.wsaaUrl, '', envelope));
  const inner = xmlUnescape(xmlVal(resXml, 'loginCmsReturn'));
  const token = xmlVal(inner, 'token');
  const sign = xmlVal(inner, 'sign');
  const expiration = xmlVal(inner, 'expirationTime');
  if (!token || !sign) throw new Error('WSAA no devolvió token/sign. Verificá el certificado y la delegación del servicio wsfe.');

  const ta = { token, sign, expiration, production: config.production, cuit: config.cuit };
  try {
    fs.mkdirSync(path.dirname(config.taCacheFile), { recursive: true });
    fs.writeFileSync(config.taCacheFile, JSON.stringify(ta));
  } catch (_e) { /* cache no crítico */ }
  return ta;
}

// ── WSFEv1 ──
// `reintentos: 0` para las llamadas que NO son idempotentes (FECAESolicitar).
async function wsfeCall(method, innerXml, { reintentos = RETRY_DELAYS_MS.length } = {}, config = DEFAULT_CONFIG) {
  const enviar = async () => {
    const ta = await getTA(config);
    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soap:Body>
    <ar:${method}>
      <ar:Auth>
        <ar:Token>${ta.token}</ar:Token>
        <ar:Sign>${ta.sign}</ar:Sign>
        <ar:Cuit>${config.cuit}</ar:Cuit>
      </ar:Auth>
      ${innerXml}
    </ar:${method}>
  </soap:Body>
</soap:Envelope>`;
    const resXml = await soapPost(config.wsfeUrl, `http://ar.gov.afip.dif.FEV1/${method}`, envelope);

    // Errores a nivel servicio
    const errBlock = xmlVal(resXml, 'Errors');
    if (errBlock) {
      const code = Number(xmlVal(errBlock, 'Code')) || 0;
      const msg = xmlVal(errBlock, 'Msg');
      const err = new Error(`ARCA WSFE error ${code}: ${msg}`);
      err.arcaCode = code;
      // Ticket de acceso vencido o inválido: tiramos el cache para forzar un
      // login nuevo. Si no, toda factura falla hasta borrar el archivo a mano.
      if (code === 600 || /token|sign/i.test(msg)) {
        try { fs.unlinkSync(config.taCacheFile); } catch (_e) { /* ya no estaba */ }
        throw retryable(err);
      }
      throw err;
    }
    return resXml;
  };
  return reintentos > 0 ? withRetry(enviar, reintentos) : enviar();
}

async function lastVoucher(ptoVta, cbteTipo, config = DEFAULT_CONFIG) {
  const xml = await wsfeCall('FECompUltimoAutorizado',
    `<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo>`, {}, config);
  return Number(xmlVal(xml, 'CbteNro') || 0);
}

/**
 * Consulta un comprobante ya emitido (FECompConsultar). Devuelve null si ARCA no
 * lo tiene registrado. Es la pieza que hace seguro el reintento: antes de volver
 * a pedir un CAE preguntamos si ese número ya salió, para no duplicar la factura.
 */
async function fetchVoucher(ptoVta, cbteTipo, cbteNro, config = DEFAULT_CONFIG) {
  let xml;
  try {
    xml = await wsfeCall('FECompConsultar',
      `<ar:FeCompConsReq><ar:CbteTipo>${cbteTipo}</ar:CbteTipo><ar:CbteNro>${cbteNro}</ar:CbteNro><ar:PtoVta>${ptoVta}</ar:PtoVta></ar:FeCompConsReq>`, {}, config);
  } catch (err) {
    // 602 = "no existen datos para los parámetros ingresados": el comprobante no se emitió.
    if (err.arcaCode === 602 || /no existen datos/i.test(err.message)) return null;
    throw err;
  }
  const cae = xmlVal(xml, 'CodAutorizacion');
  if (!cae) return null;
  return { cae, caeVto: xmlVal(xml, 'FchVto'), fechaCbte: xmlVal(xml, 'CbteFch') };
}

const CBTE_LETTER = { 1: 'A', 6: 'B', 11: 'C' };

/**
 * Emite un comprobante y devuelve CAE + datos para el QR.
 * @param {object} p
 *  - cbteTipo: 1 (Factura A) | 6 (Factura B) | 11 (Factura C)
 *  - concepto: 1 productos | 2 servicios | 3 ambos
 *  - docTipo: 80 CUIT | 96 DNI | 99 consumidor final
 *  - docNro: número de documento (0 para consumidor final)
 *  - impTotal: importe total
 *  - condIvaReceptor: condición de IVA del receptor (RG 5616): 1 RI, 4 exento, 5 CF, 6 monotributo
 * @param {object} hooks
 *  - onNumeroReservado(cbteNro): se llama con el número correlativo ANTES de pedir
 *    el CAE, para que el llamador lo persista. Sin esto no se puede reconciliar
 *    después de un corte de red.
 *  - reconciliarCbteNro: al reintentar un borrador, el número que había quedado
 *    reservado. Se consulta primero en ARCA y, si ya tiene CAE, se adopta en vez
 *    de emitir de nuevo.
 */
async function emitInvoice(p, hooks = {}, config = DEFAULT_CONFIG) {
  if (!isConfigured(config)) {
    throw new Error('ARCA no está configurado. Definí ARCA_CUIT, ARCA_CERT_PATH y ARCA_KEY_PATH en .env (ver COBRANZAS_SETUP.md).');
  }
  const cbteTipo = Number(p.cbteTipo);
  if (!CBTE_LETTER[cbteTipo]) throw new Error('Tipo de comprobante inválido (1, 6 u 11).');
  const concepto = [1, 2, 3].includes(Number(p.concepto)) ? Number(p.concepto) : 2;
  const docTipo = Number(p.docTipo || 99);
  const docNro = String(p.docNro || '').replace(/\D/g, '') || '0';
  const impTotal = Math.round(Number(p.impTotal) * 100) / 100;
  if (!Number.isFinite(impTotal) || impTotal <= 0) throw new Error('Importe inválido.');
  const condIva = Number(p.condIvaReceptor || (docTipo === 80 ? 1 : 5));
  const ptoVta = Number(p.ptoVta || config.ptoVta);

  const hoy = new Date();
  const fechaCbte = hoy.toISOString().slice(0, 10).replace(/-/g, '');

  // Factura C: sin discriminar IVA. A/B: se asume IVA 21% incluido en el total.
  let impNeto, impIVA, ivaXml = '';
  if (cbteTipo === 11) {
    impNeto = impTotal;
    impIVA = 0;
  } else {
    impNeto = Math.round((impTotal / 1.21) * 100) / 100;
    impIVA = Math.round((impTotal - impNeto) * 100) / 100;
    ivaXml = `<ar:Iva><ar:AlicIva><ar:Id>5</ar:Id><ar:BaseImp>${impNeto.toFixed(2)}</ar:BaseImp><ar:Importe>${impIVA.toFixed(2)}</ar:Importe></ar:AlicIva></ar:Iva>`;
  }

  // Para servicios (concepto 2/3) son obligatorias las fechas de servicio y vto de pago
  const fechasServicio = concepto !== 1
    ? `<ar:FchServDesde>${fechaCbte}</ar:FchServDesde><ar:FchServHasta>${fechaCbte}</ar:FchServHasta><ar:FchVtoPago>${fechaCbte}</ar:FchVtoPago>`
    : '';

  const detalleXml = (cbteNro) => `
    <ar:FeCAEReq>
      <ar:FeCabReq>
        <ar:CantReg>1</ar:CantReg>
        <ar:PtoVta>${ptoVta}</ar:PtoVta>
        <ar:CbteTipo>${cbteTipo}</ar:CbteTipo>
      </ar:FeCabReq>
      <ar:FeDetReq>
        <ar:FECAEDetRequest>
          <ar:Concepto>${concepto}</ar:Concepto>
          <ar:DocTipo>${docTipo}</ar:DocTipo>
          <ar:DocNro>${docNro}</ar:DocNro>
          <ar:CbteDesde>${cbteNro}</ar:CbteDesde>
          <ar:CbteHasta>${cbteNro}</ar:CbteHasta>
          <ar:CbteFch>${fechaCbte}</ar:CbteFch>
          <ar:ImpTotal>${impTotal.toFixed(2)}</ar:ImpTotal>
          <ar:ImpTotConc>0</ar:ImpTotConc>
          <ar:ImpNeto>${impNeto.toFixed(2)}</ar:ImpNeto>
          <ar:ImpOpEx>0</ar:ImpOpEx>
          <ar:ImpTrib>0</ar:ImpTrib>
          <ar:ImpIVA>${impIVA.toFixed(2)}</ar:ImpIVA>
          ${fechasServicio}
          <ar:MonId>PES</ar:MonId>
          <ar:MonCotiz>1</ar:MonCotiz>
          <ar:CondicionIVAReceptorId>${condIva}</ar:CondicionIVAReceptorId>
          ${ivaXml}
        </ar:FECAEDetRequest>
      </ar:FeDetReq>
    </ar:FeCAEReq>`;

  const yyyymmddAIso = (s) => (s && s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : '');

  // Arma el resultado final, venga el CAE de FECAESolicitar o de una reconciliación.
  const armarResultado = (cbteNro, r) => {
    const fecha = yyyymmddAIso(r.fechaCbte) || hoy.toISOString().slice(0, 10);
    const qrPayload = {
      ver: 1,
      fecha,
      cuit: Number(config.cuit),
      ptoVta,
      tipoCmp: cbteTipo,
      nroCmp: cbteNro,
      importe: impTotal,
      moneda: 'PES',
      ctz: 1,
      tipoDocRec: docTipo,
      nroDocRec: Number(docNro),
      tipoCodAut: 'E',
      codAut: Number(r.cae),
    };
    return {
      cbteTipo,
      cbteLetra: CBTE_LETTER[cbteTipo],
      ptoVta,
      cbteNro,
      numero: `${String(ptoVta).padStart(4, '0')}-${String(cbteNro).padStart(8, '0')}`,
      fecha,
      docTipo,
      docNro,
      impTotal,
      impNeto,
      impIVA,
      cae: r.cae,
      caeVto: yyyymmddAIso(r.caeVto),
      qrUrl: 'https://www.afip.gob.ar/fe/qr/?p=' + Buffer.from(JSON.stringify(qrPayload)).toString('base64'),
      production: config.production,
    };
  };

  // Reintento de un borrador: si el número reservado la vez anterior ya tiene CAE,
  // la factura sí se emitió (se perdió la respuesta). La adoptamos, no emitimos otra.
  if (hooks.reconciliarCbteNro) {
    const ya = await fetchVoucher(ptoVta, cbteTipo, Number(hooks.reconciliarCbteNro), config);
    if (ya) return armarResultado(Number(hooks.reconciliarCbteNro), ya);
  }

  const MAX_INTENTOS = 3;
  for (let intento = 1; ; intento++) {
    // Se recalcula en cada vuelta: otro comprobante pudo haber avanzado la numeración.
    const cbteNro = (await lastVoucher(ptoVta, cbteTipo, config)) + 1;
    if (hooks.onNumeroReservado) await hooks.onNumeroReservado(cbteNro);

    let xml;
    try {
      // reintentos: 0 — reenviar esto a ciegas duplicaría la factura.
      xml = await wsfeCall('FECAESolicitar', detalleXml(cbteNro), { reintentos: 0 }, config);
    } catch (err) {
      if (!err.arcaRetryable) throw err;

      // Zona gris: se cortó la comunicación, pero ARCA pudo haber procesado el pedido.
      // Nunca reenviamos sin antes preguntar si ese número ya salió.
      let ya;
      try {
        ya = await fetchVoucher(ptoVta, cbteTipo, cbteNro, config);
      } catch (e) {
        throw retryable(new Error(
          `No se pudo confirmar en ARCA si el comprobante ${ptoVta}-${cbteNro} llegó a emitirse (${e.message}). ` +
          'Quedó guardado como borrador: al reintentar se verifica antes de volver a emitir.'
        ));
      }
      if (ya) return armarResultado(cbteNro, ya);

      if (intento >= MAX_INTENTOS) throw err;
      await sleep(RETRY_DELAYS_MS[Math.min(intento - 1, RETRY_DELAYS_MS.length - 1)]);
      continue;
    }

    const resultado = xmlVal(xml, 'Resultado'); // A aprobado, R rechazado
    const cae = xmlVal(xml, 'CAE');
    if (resultado !== 'A' || !cae) {
      const obs = xmlVal(xml, 'Observaciones');
      const motivo = obs ? `${xmlVal(obs, 'Code')}: ${xmlVal(obs, 'Msg')}` : 'sin detalle';
      const err = new Error(`ARCA rechazó el comprobante (${motivo}).`);
      // Rechazo por datos: reintentar sin corregir da siempre lo mismo.
      err.arcaRechazo = true;
      throw err;
    }
    return armarResultado(cbteNro, { cae, caeVto: xmlVal(xml, 'CAEFchVto') });
  }
}

function forAccount(id = 'default') {
  const config = ACCOUNTS[id] || DEFAULT_CONFIG;
  return {
    isConfigured: () => isConfigured(config),
    status: () => status(config),
    emitInvoice: (p, hooks) => emitInvoice(p, hooks, config),
    lastVoucher: (ptoVta, cbteTipo) => lastVoucher(ptoVta, cbteTipo, config),
    fetchVoucher: (ptoVta, cbteTipo, cbteNro) => fetchVoucher(ptoVta, cbteTipo, cbteNro, config),
  };
}

module.exports = { isConfigured, status, accountsStatus, forAccount, emitInvoice, lastVoucher, fetchVoucher };
