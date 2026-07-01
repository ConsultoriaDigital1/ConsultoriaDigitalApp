// Generación del PDF de factura electrónica (layout estándar ARCA: letra,
// datos del emisor/receptor, importes, CAE y QR oficial).
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const CBTE_NOMBRE = { 1: 'FACTURA A', 6: 'FACTURA B', 11: 'FACTURA C' };
const DOC_NOMBRE = { 80: 'CUIT', 96: 'DNI', 99: 'Consumidor Final' };
const COND_IVA_EMISOR = process.env.ARCA_COND_IVA || 'Responsable Monotributo';

// Logo del emisor (opcional). Ruta configurable; por defecto .local/arca/logo.png
const LOGO_PATH = process.env.ARCA_LOGO_PATH || path.join(__dirname, '.local', 'arca', 'logo.png');
const LOGO_BUFFER = (() => {
  try { return fs.existsSync(LOGO_PATH) ? fs.readFileSync(LOGO_PATH) : null; }
  catch (_e) { return null; }
})();

const EMISOR = {
  razonSocial: process.env.ARCA_RAZON_SOCIAL || 'CONSULTORIA DIGITAL',
  domicilio: process.env.ARCA_DOMICILIO || '',
  iibb: process.env.ARCA_IIBB || '',
  inicioActividades: process.env.ARCA_INICIO_ACTIVIDADES || '',
};

function money(n) {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(n) || 0);
}

function fmtFecha(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Genera el PDF de una factura. Devuelve una Promise<Buffer>.
 * @param {object} inv fila DTO de invoices (cbteTipo, numero, fecha, cae, ...)
 * @param {object} client cliente (razonSocial, cuit, direccion, ...)
 * @param {string} cuitEmisor CUIT con el que se emitió
 */
async function buildInvoicePdf(inv, client, cuitEmisor) {
  const qrPng = inv.qrUrl
    ? await QRCode.toBuffer(inv.qrUrl, { type: 'png', width: 220, margin: 1 })
    : null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 80; // ancho útil
    const X = 40;
    let y = 40;

    // Marca de agua si es comprobante de homologación
    if (!inv.production) {
      doc.save().rotate(-30, { origin: [300, 420] })
        .fontSize(48).fillColor('#cccccc').opacity(0.45)
        .text('SIN VALIDEZ FISCAL — PRUEBA', 60, 380, { width: 560, align: 'center' })
        .opacity(1).restore();
    }

    // ── Cabecera: emisor | letra | datos del comprobante ──
    doc.rect(X, y, W, 110).stroke('#333333');
    const midX = X + W / 2;

    // Recuadro de la letra
    const letterBox = 44;
    doc.rect(midX - letterBox / 2, y, letterBox, letterBox).stroke('#333333');
    doc.fillColor('#000').fontSize(26).font('Helvetica-Bold')
      .text(inv.cbteLetra || 'C', midX - letterBox / 2, y + 8, { width: letterBox, align: 'center' });
    doc.fontSize(7).font('Helvetica')
      .text(`COD. ${String(inv.cbteTipo).padStart(2, '0')}`, midX - letterBox / 2, y + 34, { width: letterBox, align: 'center' });

    // Emisor (izquierda). Si hay logo, va arriba y la razón social debajo.
    const emisorW = W / 2 - letterBox / 2 - 20;
    let nameY = y + 12;
    if (LOGO_BUFFER) {
      try {
        doc.image(LOGO_BUFFER, X + 10, y + 10, { fit: [140, 30], align: 'left', valign: 'top' });
        nameY = y + 46;
      } catch (_e) { /* logo inválido: se ignora y se muestra solo el texto */ }
    }
    doc.fillColor('#000').fontSize(14).font('Helvetica-Bold')
      .text(EMISOR.razonSocial, X + 10, nameY, { width: emisorW });
    doc.fontSize(8.5).font('Helvetica');
    let ey = nameY + 22;
    const emisorLines = [
      EMISOR.domicilio && `Domicilio: ${EMISOR.domicilio}`,
      `Condición frente al IVA: ${COND_IVA_EMISOR}`,
      EMISOR.iibb && `Ingresos Brutos: ${EMISOR.iibb}`,
      EMISOR.inicioActividades && `Inicio de actividades: ${EMISOR.inicioActividades}`,
    ].filter(Boolean);
    emisorLines.forEach((l) => { doc.text(l, X + 10, ey, { width: W / 2 - letterBox / 2 - 20 }); ey += 12; });

    // Comprobante (derecha)
    doc.fontSize(13).font('Helvetica-Bold')
      .text(CBTE_NOMBRE[inv.cbteTipo] || 'COMPROBANTE', midX + letterBox / 2 + 10, y + 12);
    doc.fontSize(9).font('Helvetica');
    let cy = y + 34;
    [
      `Punto de Venta: ${String(inv.ptoVta).padStart(4, '0')}    Comp. Nro: ${String(inv.cbteNro).padStart(8, '0')}`,
      `Fecha de Emisión: ${fmtFecha(inv.fecha)}`,
      `CUIT: ${cuitEmisor}`,
    ].forEach((l) => { doc.text(l, midX + letterBox / 2 + 10, cy); cy += 14; });

    y += 122;

    // ── Receptor ──
    doc.rect(X, y, W, 58).stroke('#333333');
    doc.fontSize(9).font('Helvetica-Bold').text('Cliente:', X + 10, y + 10);
    doc.font('Helvetica')
      .text(client.razonSocial || client.nombreFantasia || '-', X + 70, y + 10)
      .text(inv.docNro !== '0'
        ? `${DOC_NOMBRE[inv.docTipo] || 'Doc'}: ${inv.docNro}`
        : 'Condición: Consumidor Final', X + 10, y + 26)
      .text(client.direccion ? `Domicilio: ${client.direccion}` : '', X + 10, y + 42);
    y += 70;

    // ── Detalle ──
    doc.rect(X, y, W, 24).fillAndStroke('#eeeeee', '#333333');
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(9);
    doc.text('Descripción', X + 10, y + 7, { width: W - 130 });
    doc.text('Importe', X + W - 110, y + 7, { width: 100, align: 'right' });
    y += 24;

    const detalle = inv.detalle || 'Servicios profesionales';
    doc.rect(X, y, W, 28).stroke('#333333');
    doc.font('Helvetica').fontSize(9.5);
    doc.text(detalle, X + 10, y + 9, { width: W - 130 });
    doc.text(money(inv.impTotal), X + W - 110, y + 9, { width: 100, align: 'right' });
    y += 40;

    // ── Totales ──
    const showIva = inv.cbteTipo !== 11 && Number(inv.impIVA || 0) > 0;
    const totRows = showIva
      ? [['Importe Neto Gravado', inv.impNeto], ['IVA 21%', inv.impIVA], ['Importe Total', inv.impTotal]]
      : [['Importe Total', inv.impTotal]];
    totRows.forEach(([label, val], i) => {
      const bold = i === totRows.length - 1;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5);
      doc.text(`${label}:`, X + W - 280, y, { width: 160, align: 'right' });
      doc.text(money(val), X + W - 110, y, { width: 100, align: 'right' });
      y += bold ? 18 : 15;
    });
    y += 20;

    // ── Pie: QR + CAE ──
    const footY = Math.max(y, 640);
    if (qrPng) doc.image(qrPng, X, footY, { width: 100 });
    doc.font('Helvetica-Bold').fontSize(10)
      .text(`CAE N°: ${inv.cae}`, X + 120, footY + 20)
      .text(`Fecha de Vto. de CAE: ${fmtFecha(inv.caeVto)}`, X + 120, footY + 36);
    doc.font('Helvetica').fontSize(7.5).fillColor('#555555')
      .text('Comprobante Autorizado — Esta Administración Federal no se responsabiliza por los datos ingresados en el detalle de la operación.',
        X + 120, footY + 56, { width: W - 130 });

    doc.end();
  });
}

module.exports = { buildInvoicePdf };
