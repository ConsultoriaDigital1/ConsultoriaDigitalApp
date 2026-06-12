// ─────────────────────────────────────────────────────────────────────────────
// Integración con ARCA (ex AFIP) — Factura electrónica
//   WSAA  : autenticación con certificado digital (CMS/PKCS#7 firmado)
//   WSFEv1: solicitud de CAE (FECAESolicitar) y último comprobante autorizado
// Sin SDKs externos: SOAP crudo sobre fetch + firma con node-forge.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const forge = require('node-forge');

const CUIT = String(process.env.ARCA_CUIT || '').replace(/\D/g, '');
const PRODUCTION = process.env.ARCA_PRODUCTION === 'true';
const CERT_PATH = process.env.ARCA_CERT_PATH || '';
const KEY_PATH = process.env.ARCA_KEY_PATH || '';
const PTO_VTA = Number(process.env.ARCA_PTO_VTA || 1);

const WSAA_URL = PRODUCTION
  ? 'https://wsaa.afip.gov.ar/ws/services/LoginCms'
  : 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms';
const WSFE_URL = PRODUCTION
  ? 'https://servicios1.afip.gov.ar/wsfev1/service.asmx'
  : 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx';

// Cache del Ticket de Acceso (dura 12 h) para no pegarle a WSAA en cada factura
const TA_CACHE_FILE = path.join(__dirname, '.local', 'arca-ta.json');

function isConfigured() {
  return Boolean(CUIT && CERT_PATH && KEY_PATH && fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH));
}

function status() {
  return {
    configured: isConfigured(),
    production: PRODUCTION,
    cuit: CUIT,
    ptoVta: PTO_VTA,
  };
}

// ── helpers XML (las respuestas de ARCA son acotadas y predecibles) ──
function xmlVal(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : '';
}

function xmlUnescape(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function soapPost(url, action, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      ...(action ? { SOAPAction: action } : {}),
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    const fault = xmlVal(text, 'faultstring') || text.slice(0, 300);
    throw new Error(`ARCA respondió ${res.status}: ${fault}`);
  }
  return text;
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

function signTRA(tra) {
  const certPem = fs.readFileSync(CERT_PATH, 'utf8');
  const keyPem = fs.readFileSync(KEY_PATH, 'utf8');
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

function readCachedTA() {
  try {
    const ta = JSON.parse(fs.readFileSync(TA_CACHE_FILE, 'utf8'));
    // margen de 5 minutos antes del vencimiento
    if (ta && ta.production === PRODUCTION && ta.cuit === CUIT && Date.parse(ta.expiration) - Date.now() > 5 * 60 * 1000) {
      return ta;
    }
  } catch (_e) { /* sin cache */ }
  return null;
}

async function getTA() {
  const cached = readCachedTA();
  if (cached) return cached;

  const cms = signTRA(buildTRA());
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Body>
    <wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;

  const resXml = await soapPost(WSAA_URL, '', envelope);
  const inner = xmlUnescape(xmlVal(resXml, 'loginCmsReturn'));
  const token = xmlVal(inner, 'token');
  const sign = xmlVal(inner, 'sign');
  const expiration = xmlVal(inner, 'expirationTime');
  if (!token || !sign) throw new Error('WSAA no devolvió token/sign. Verificá el certificado y la delegación del servicio wsfe.');

  const ta = { token, sign, expiration, production: PRODUCTION, cuit: CUIT };
  try {
    fs.mkdirSync(path.dirname(TA_CACHE_FILE), { recursive: true });
    fs.writeFileSync(TA_CACHE_FILE, JSON.stringify(ta));
  } catch (_e) { /* cache no crítico */ }
  return ta;
}

// ── WSFEv1 ──
async function wsfeCall(method, innerXml) {
  const ta = await getTA();
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soap:Body>
    <ar:${method}>
      <ar:Auth>
        <ar:Token>${ta.token}</ar:Token>
        <ar:Sign>${ta.sign}</ar:Sign>
        <ar:Cuit>${CUIT}</ar:Cuit>
      </ar:Auth>
      ${innerXml}
    </ar:${method}>
  </soap:Body>
</soap:Envelope>`;
  const resXml = await soapPost(WSFE_URL, `http://ar.gov.afip.dif.FEV1/${method}`, envelope);

  // Errores a nivel servicio
  const errBlock = xmlVal(resXml, 'Errors');
  if (errBlock) {
    const code = xmlVal(errBlock, 'Code');
    const msg = xmlVal(errBlock, 'Msg');
    throw new Error(`ARCA WSFE error ${code}: ${msg}`);
  }
  return resXml;
}

async function lastVoucher(ptoVta, cbteTipo) {
  const xml = await wsfeCall('FECompUltimoAutorizado',
    `<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo>`);
  return Number(xmlVal(xml, 'CbteNro') || 0);
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
 */
async function emitInvoice(p) {
  if (!isConfigured()) {
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
  const ptoVta = Number(p.ptoVta || PTO_VTA);

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

  const cbteNro = (await lastVoucher(ptoVta, cbteTipo)) + 1;

  const detalle = `
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

  const xml = await wsfeCall('FECAESolicitar', detalle);

  const resultado = xmlVal(xml, 'Resultado'); // A aprobado, R rechazado
  const cae = xmlVal(xml, 'CAE');
  const caeVto = xmlVal(xml, 'CAEFchVto');

  if (resultado !== 'A' || !cae) {
    const obs = xmlVal(xml, 'Observaciones');
    const motivo = obs ? `${xmlVal(obs, 'Code')}: ${xmlVal(obs, 'Msg')}` : 'sin detalle';
    throw new Error(`ARCA rechazó el comprobante (${motivo}).`);
  }

  // QR oficial de ARCA para impresión del comprobante
  const qrPayload = {
    ver: 1,
    fecha: hoy.toISOString().slice(0, 10),
    cuit: Number(CUIT),
    ptoVta,
    tipoCmp: cbteTipo,
    nroCmp: cbteNro,
    importe: impTotal,
    moneda: 'PES',
    ctz: 1,
    tipoDocRec: docTipo,
    nroDocRec: Number(docNro),
    tipoCodAut: 'E',
    codAut: Number(cae),
  };
  const qrUrl = 'https://www.afip.gob.ar/fe/qr/?p=' + Buffer.from(JSON.stringify(qrPayload)).toString('base64');

  return {
    cbteTipo,
    cbteLetra: CBTE_LETTER[cbteTipo],
    ptoVta,
    cbteNro,
    numero: `${String(ptoVta).padStart(4, '0')}-${String(cbteNro).padStart(8, '0')}`,
    fecha: hoy.toISOString().slice(0, 10),
    docTipo,
    docNro,
    impTotal,
    impNeto,
    impIVA,
    cae,
    caeVto: caeVto ? `${caeVto.slice(0, 4)}-${caeVto.slice(4, 6)}-${caeVto.slice(6, 8)}` : '',
    qrUrl,
    production: PRODUCTION,
  };
}

module.exports = { isConfigured, status, emitInvoice, lastVoucher };
