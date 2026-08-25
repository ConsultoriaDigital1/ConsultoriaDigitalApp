// Generación del PDF de factura electrónica (layout ARCA con diseño de tarjeta:
// cabecera con letra en recuadro, datos del emisor/receptor con íconos,
// resumen de importes destacado, CAE y QR oficial en el pie).
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const CBTE_NOMBRE = { 0: 'COMPROBANTE', 1: 'FACTURA A', 6: 'FACTURA B', 11: 'FACTURA C' };
const DOC_NOMBRE = { 80: 'CUIT', 96: 'DNI', 99: 'Consumidor Final' };

// Paleta del diseño
const NAVY = '#16233f';   // azul oscuro (recuadro letra, encabezado tabla, líneas)
const INK = '#1f2937';    // texto principal
const LABEL = '#5b6472';  // etiquetas / íconos
const MUTED = '#6b7280';  // texto secundario
const CARD_BG = '#f7f8fa';
const CARD_BORDER = '#e6e8ec';
const SUMMARY_BG = '#f9fafc';
const TOTAL_BG = '#eef1f8';
const FOOTER_BG = '#f4f5f7';

const DEFAULT_EMISOR = {
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

function fmtCuit(cuit) {
  const digits = String(cuit || '').replace(/\D/g, '');
  return digits.length === 11 ? `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}` : (cuit || '');
}

// ── Íconos vectoriales (estilo lineal, viewBox 24×24) ──
function circlePath(cx, cy, r) {
  return `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`;
}
const ICONS = {
  pin: `M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z ${circlePath(12, 10, 3)}`,
  calendar: 'M4 6h16v15H4z M9 3v4 M15 3v4 M4 11h16',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M9 13h6 M9 17h6',
  chart: 'M6 20v-6 M12 20V5 M18 20v-9 M4 20h16',
  card: 'M3 6h18v12H3z M3 10h18',
  user: `${circlePath(12, 9, 3.5)} M6 20a6 6 0 0 1 12 0`,
  shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z',
};

function drawIcon(doc, name, x, y, size, color) {
  const p = ICONS[name];
  if (!p) return;
  const s = size / 24;
  doc.save();
  doc.translate(x, y).scale(s);
  doc.lineWidth(1.7 / s).lineJoin('round').lineCap('round');
  doc.strokeColor(color).path(p).stroke();
  doc.restore();
}

// Fila "ícono + texto" con la etiqueta en negrita opcional
function fieldRow(doc, icon, x, y, opts) {
  const { label, value, width, iconColor = LABEL, valueColor = INK, size = 8.5, gap = 8, iconSize = 11.5 } = opts;
  drawIcon(doc, icon, x, y - (iconSize - size) / 2 - 0.5, iconSize, iconColor);
  const tx = x + iconSize + gap;
  let cursor = tx;
  doc.fontSize(size);
  if (label) {
    doc.font('Helvetica-Bold').fillColor(valueColor).text(label, tx, y, { continued: true, width: width && width - (iconSize + gap) });
    cursor = doc.x;
    doc.font('Helvetica').fillColor(valueColor).text(value ? ` ${value}` : '', { width: width && width - (iconSize + gap) });
  } else {
    doc.font('Helvetica').fillColor(valueColor).text(value || '', tx, y, { width: width && width - (iconSize + gap) });
  }
  return cursor;
}

/**
 * Genera el PDF de una factura. Devuelve una Promise<Buffer>.
 * @param {object} inv fila DTO de invoices (cbteTipo, numero, fecha, cae, ...)
 * @param {object} client cliente (razonSocial, cuit, direccion, ...)
 * @param {string} cuitEmisor CUIT con el que se emitió
 */
async function buildInvoicePdf(inv, client, cuitEmisor, emisorData = {}) {
  const emisor = { ...DEFAULT_EMISOR, ...emisorData };
  const cuitEnDatosEmisor = emisor.id === 'comydes';
  const logoBuffer = (() => {
    try { return emisor.logoPath && fs.existsSync(emisor.logoPath) ? fs.readFileSync(emisor.logoPath) : null; }
    catch (_e) { return null; }
  })();
  // Comprobante "sin ARCA": no fiscal, sin CAE ni QR (tipo 0 / letra X).
  const sinArca = Number(inv.cbteTipo) === 0 || !inv.cae;
  const qrPng = inv.qrUrl
    ? await QRCode.toBuffer(inv.qrUrl, { type: 'png', width: 220, margin: 1 })
    : null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width;
    const X = 40;
    const W = pageW - 2 * X;
    const midX = X + W / 2;

    // Líneas de acento superior/inferior a todo el ancho
    doc.rect(0, 0, pageW, 5).fill(NAVY);

    // Marca de agua sólo para comprobantes de homologación (prueba).
    if (!sinArca && !inv.production) {
      doc.save().rotate(-30, { origin: [300, 420] })
        .fontSize(48).fillColor('#cccccc').opacity(0.4)
        .text('SIN VALIDEZ FISCAL — PRUEBA', 60, 380, { width: 560, align: 'center' })
        .opacity(1).restore();
    }

    // ══════════════ Cabecera ══════════════
    const headY = 34;
    const letterBox = 60;
    const boxX = midX - 24;

    // Recuadro de la letra (badge navy redondeado)
    doc.roundedRect(boxX, headY, letterBox, letterBox, 10).fill(NAVY);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(30)
      .text(inv.cbteLetra || 'C', boxX, headY + 9, { width: letterBox, align: 'center' });
    doc.font('Helvetica').fontSize(7.5)
      .text(`COD. ${String(inv.cbteTipo).padStart(2, '0')}`, boxX, headY + 42, { width: letterBox, align: 'center' });

    // Emisor (izquierda): logo o razón social + datos con íconos
    const emisorW = boxX - 24 - X;
    let nameY = headY;
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, X, headY, { fit: [190, 66], align: 'left', valign: 'top' });
        nameY = headY + 74;
        doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(16).text(emisor.razonSocial, X, nameY, { width: emisorW });
        nameY += 25;
      } catch (_e) {
        doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(20).text(emisor.razonSocial, X, headY, { width: emisorW });
        nameY = headY + 30;
      }
    } else {
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(20).text(emisor.razonSocial, X, headY, { width: emisorW });
      nameY = headY + 30;
    }

    let ey = nameY;
    const emisorFields = [
      cuitEnDatosEmisor && cuitEmisor && ['card', 'CUIT:', fmtCuit(cuitEmisor)],
      emisor.domicilio && ['pin', 'Domicilio:', emisor.domicilio],
      ['file', 'Condición frente al IVA:', emisor.condIva],
      emisor.iibb && ['chart', 'Ingresos Brutos:', emisor.iibb],
      emisor.inicioActividades && ['calendar', 'Inicio de actividades:', emisor.inicioActividades],
    ].filter(Boolean);
    emisorFields.forEach(([ic, label, val]) => {
      fieldRow(doc, ic, X, ey, { label, value: val, width: emisorW, size: 8 });
      ey += 17.5;
    });

    // Divisor vertical entre columnas
    const divX = boxX - 12;
    const divTop = headY + 4;
    const divBot = Math.max(ey, headY + letterBox + 6);
    doc.save().moveTo(divX, divTop).lineTo(divX, divBot)
      .lineWidth(1).strokeColor(CARD_BORDER).stroke().restore();

    // Comprobante (derecha)
    const rx = boxX + letterBox + 16;
    const rw = X + W - rx;
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(21)
      .text(CBTE_NOMBRE[inv.cbteTipo] || 'COMPROBANTE', rx, headY + 4);
    let ry = headY + 36;
    fieldRow(doc, 'pin', rx, ry, {
      label: `Punto de Venta: ${String(inv.ptoVta).padStart(4, '0')}`,
      value: `   Comp. Nro: ${String(inv.cbteNro).padStart(8, '0')}`, width: rw, size: 8.5,
    });
    ry += 18;
    fieldRow(doc, 'calendar', rx, ry, { label: 'Fecha de Emisión:', value: fmtFecha(inv.fecha), width: rw, size: 8.5 });
    ry += 18;
    if (!cuitEnDatosEmisor) {
      fieldRow(doc, 'user', rx, ry, { label: 'CUIT:', value: fmtCuit(cuitEmisor), width: rw, size: 8.5 });
    }

    let y = Math.max(ey, ry + 24, headY + letterBox) + 18;

    // ══════════════ Receptor ══════════════
    const recH = 78;
    doc.roundedRect(X, y, W, recH, 10).fillAndStroke(CARD_BG, CARD_BORDER);
    // Avatar
    const avR = 26;
    const avCx = X + 34;
    const avCy = y + recH / 2;
    doc.circle(avCx, avCy, avR).fill(NAVY);
    drawIcon(doc, 'user', avCx - 13, avCy - 13, 26, '#ffffff');

    const cx0 = X + 72;
    const cw = W - 72 - 20;
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10)
      .text('Cliente:', cx0, y + 14, { continued: true });
    doc.fillColor(INK).text(`   ${client.razonSocial || client.nombreFantasia || '-'}`, { width: cw });
    let cy = y + 36;
    fieldRow(doc, 'card', cx0, cy, {
      label: inv.docNro !== '0' ? `${DOC_NOMBRE[inv.docTipo] || 'Doc'}:` : 'Condición:',
      value: inv.docNro !== '0' ? inv.docNro : 'Consumidor Final', width: cw, size: 9, iconSize: 12,
    });
    cy += 19;
    if (client.direccion) {
      fieldRow(doc, 'pin', cx0, cy, { label: 'Domicilio:', value: client.direccion, width: cw, size: 9, iconSize: 12 });
    }
    y += recH + 20;

    // ══════════════ Detalle ══════════════
    const barH = 30;
    doc.roundedRect(X, y, W, barH, 8).fill(NAVY);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10);
    doc.text('Descripción', X + 16, y + 9, { width: W - 150 });
    doc.text('Importe', X + W - 130, y + 9, { width: 114, align: 'right' });
    y += barH + 6;

    const items = Array.isArray(inv.items) && inv.items.length
      ? inv.items
      : [{ detalle: inv.detalle || 'Servicios profesionales', importe: inv.impTotal }];
    items.forEach((it) => {
      const txt = it.detalle || 'Ítem';
      doc.font('Helvetica').fontSize(10);
      const txtH = doc.heightOfString(txt, { width: W - 160 });
      const rowH = Math.max(38, txtH + 20);
      doc.roundedRect(X, y, W, rowH, 8).fill(CARD_BG);
      doc.fillColor(INK).font('Helvetica').fontSize(10)
        .text(txt, X + 16, y + (rowH - txtH) / 2, { width: W - 160 });
      doc.text(money(it.importe), X + W - 130, y + (rowH - 12) / 2, { width: 114, align: 'right' });
      y += rowH + 6;
    });
    y += 12;

    // ══════════════ Resumen de importes ══════════════
    const showIva = inv.cbteTipo !== 11 && Number(inv.impIVA || 0) > 0;
    const sumW = W * 0.56;
    const sumX = X + W - sumW;
    const padX = 22;
    const bandH = 46;
    const rowsH = showIva ? 54 : 8;
    const sumH = rowsH + bandH + 20;
    doc.roundedRect(sumX, y, sumW, sumH, 10).fillAndStroke(SUMMARY_BG, CARD_BORDER);

    let sy = y + 16;
    if (showIva) {
      const putRow = (label, val) => {
        doc.font('Helvetica').fontSize(9.5).fillColor(MUTED)
          .text(label, sumX + padX, sy, { width: sumW / 2 });
        doc.fillColor(INK).text(money(val), sumX + sumW - padX - 140, sy, { width: 140, align: 'right' });
      };
      putRow('Importe Neto Gravado:', inv.impNeto);
      // separador punteado
      doc.save().moveTo(sumX + padX, sy + 18).lineTo(sumX + sumW - padX, sy + 18)
        .lineWidth(0.7).dash(1.5, { space: 2.5 }).strokeColor(CARD_BORDER).stroke().undash().restore();
      sy += 27;
      putRow('IVA 21%:', inv.impIVA);
      sy += 20;
    }
    // Banda destacada del total
    const bandY = y + sumH - bandH - 6;
    doc.roundedRect(sumX + 6, bandY, sumW - 12, bandH, 8).fill(TOTAL_BG);
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(15)
      .text('Importe Total:', sumX + padX, bandY + bandH / 2 - 9);
    doc.fontSize(18)
      .text(money(inv.impTotal), sumX + sumW - padX - 180, bandY + bandH / 2 - 11, { width: 180, align: 'right' });
    y += sumH + 26;

    // ══════════════ Pie ══════════════
    const footTop = Math.max(y, 690);
    // Fondo gris del pie hasta el borde de la página + divisor navy encima
    doc.rect(0, footTop, pageW, doc.page.height - footTop).fill(FOOTER_BG);
    doc.rect(0, footTop, pageW, 2).fill(NAVY);
    const fy = footTop + 26;

    if (sinArca) {
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11)
        .text('Documento no fiscal — comprobante interno', X, fy, { width: W });
      doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
        .text('Este comprobante no fue emitido ante AFIP/ARCA y no tiene validez fiscal. No válido como factura.',
          X, fy + 18, { width: W });
    } else {
      // QR con marco redondeado
      if (qrPng) {
        doc.roundedRect(X, fy, 108, 108, 8).fill('#ffffff');
        doc.image(qrPng, X + 6, fy + 6, { width: 96 });
      }
      const infoX = qrPng ? X + 128 : X;
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(12)
        .text(`CAE N°: ${inv.cae}`, infoX, fy + 12)
        .text(`Fecha de Vto. de CAE: ${fmtFecha(inv.caeVto)}`, infoX, fy + 32);
      drawIcon(doc, 'shield', infoX, fy + 62, 14, MUTED);
      doc.fillColor(MUTED).font('Helvetica').fontSize(8)
        .text('Comprobante Autorizado — Esta Administración Federal no se responsabiliza por los datos ingresados en el detalle de la operación.',
          infoX + 20, fy + 62, { width: X + W - infoX - 20 });
    }

    // Línea de acento inferior
    doc.rect(0, doc.page.height - 5, pageW, 5).fill(NAVY);

    doc.end();
  });
}

module.exports = { buildInvoicePdf };
