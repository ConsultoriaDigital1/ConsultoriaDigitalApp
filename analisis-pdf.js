// PDF de análisis para el cliente, con el mismo lenguaje visual que el de casos de
// éxito de TurnerIA: apaisado 16:9, portada azul noche con acento lima, números
// grandes y barras mensuales con la fuente al pie.
const PDFDocument = require('pdfkit');

const W = 960, H = 540, M = 56;
const C = {
  noche: '#00263d', tarjeta: '#063650', lima: '#d4f20a', blanco: '#ffffff', grisClaro: '#b8c7d1',
  papel: '#f4f4f2', tinta: '#0b2233', texto: '#4a5a66', borde: '#dfe3e6',
  barraFuerte: '#1c4a63', barraSuave: '#b9c6cf', fondoGrafico: '#e9eef1', implementa: '#eef8b8',
};
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const num = n => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));
const mesLargo = m => MESES[Number(m.slice(5, 7)) - 1];
const mesCorto = m => MES_CORTO[Number(m.slice(5, 7)) - 1];

function periodoTexto(desde, hasta) {
  if (desde === hasta) return `${mesLargo(desde)} de ${desde.slice(0, 4)}`;
  if (desde.slice(0, 4) === hasta.slice(0, 4)) return `${mesLargo(desde)} a ${mesLargo(hasta)} de ${hasta.slice(0, 4)}`;
  return `${mesLargo(desde)} de ${desde.slice(0, 4)} a ${mesLargo(hasta)} de ${hasta.slice(0, 4)}`;
}

function serie(cliente, metrica, meses) {
  const m = cliente.metricas[metrica] || {};
  return meses.map(mes => (m[mes] ? m[mes].valor : null));
}
const total = valores => valores.reduce((a, v) => a + (v || 0), 0);
const tiene = valores => valores.some(v => v != null && v > 0);

// Arma los números del informe según lo que haya para este cliente.
function armarIndicadores(cliente, meses) {
  const s = k => serie(cliente, k, meses);
  const kpis = [];
  const turnosBot = s('turnos_bot'), turnosTotal = s('turnos_total');
  const conv = s('conversaciones'), convBot = s('conv_bot');
  const rec = s('recordatorios'), asis = s('asistencias');
  const msj = s('mensajes_bot');
  if (tiene(turnosBot)) kpis.push({ valor: num(total(turnosBot)), texto: 'turnos dados por el bot en el período' });
  if (tiene(conv) && tiene(convBot)) {
    const pct = Math.round(100 * total(convBot) / total(conv));
    kpis.push({ valor: pct + ' %', texto: `de las conversaciones las resolvió el bot sin pasar a una persona (${num(total(convBot))} de ${num(total(conv))})` });
  }
  if (tiene(rec) && tiene(asis)) {
    // El último mes con los dos datos: el promedio del período lo tiran para abajo los meses de arranque.
    const i = meses.map((_, k) => k).filter(k => rec[k] > 0 && asis[k] > 0).pop();
    const deDiez = i == null ? 0 : Math.round(10 * asis[i] / rec[i]);
    if (deDiez >= 1 && deDiez <= 10) kpis.push({ valor: `${deDiez} de 10`, texto: `pacientes que recibieron el recordatorio en ${mesLargo(meses[i])} confirmaron que van` });
    else kpis.push({ valor: num(total(asis)), texto: 'asistencias confirmadas por WhatsApp' });
  }
  if (tiene(turnosBot) && tiene(turnosTotal) && kpis.length < 4) {
    const ultimo = meses.length - 1;
    const share = turnosTotal[ultimo] ? Math.round(100 * (turnosBot[ultimo] || 0) / turnosTotal[ultimo]) : null;
    if (share != null) kpis.push({ valor: share + ' %', texto: `de los turnos de ${mesLargo(meses[ultimo])} los dio el bot` });
  }
  if (tiene(msj) && kpis.length < 4) kpis.push({ valor: num(total(msj)), texto: 'mensajes atendidos por el bot' });
  for (const k of ['ventas', 'leads', 'cobros', 'usuarios', 'visitas']) {
    const v = s(k);
    if (tiene(v) && kpis.length < 4) kpis.push({ valor: num(total(v)), texto: (k === 'usuarios' ? 'usuarios activos (suma mensual)' : require('./analisis').METRICAS[k].corto) });
  }
  if (kpis.length < 4 && kpis.length) kpis.push({ valor: '24/7', texto: 'atención, también de noche, fines de semana y feriados' });

  const graficos = [];
  if (tiene(turnosTotal) || tiene(turnosBot)) {
    graficos.push({
      eyebrow: 'Turnos atendidos por mes, según quién dio el turno',
      titulo: tituloTurnos(meses, turnosBot, turnosTotal),
      series: [
        { label: 'Bot', color: C.barraFuerte, valores: turnosBot },
        { label: 'Recepción', color: C.barraSuave, valores: turnosTotal.map((t, i) => (t == null ? null : Math.max(0, t - (turnosBot[i] || 0)))) },
      ],
    });
  }
  if (tiene(conv)) {
    graficos.push({
      eyebrow: 'Conversaciones con pacientes por mes',
      titulo: tituloConversaciones(meses, conv, convBot),
      series: [
        { label: 'Resueltas por el bot', color: C.barraFuerte, valores: convBot },
        { label: 'Pasaron a una persona', color: C.barraSuave, valores: conv.map((t, i) => (t == null ? null : Math.max(0, t - (convBot[i] || 0)))) },
      ],
      porcentaje: conv.map((t, i) => (t ? Math.round(100 * (convBot[i] || 0) / t) : null)),
    });
  }
  if (!graficos.length && tiene(msj)) {
    graficos.push({ eyebrow: 'Mensajes atendidos por el bot, por mes', titulo: `${num(total(msj))} mensajes atendidos en el período`, series: [{ label: 'Mensajes atendidos', color: C.barraFuerte, valores: msj }] });
  }
  if (tiene(rec) && graficos.length < 4) {
    graficos.push({ eyebrow: 'Recordatorios y asistencias confirmadas por mes', titulo: `${num(total(asis))} asistencias confirmadas por WhatsApp`, series: [{ label: 'Asistencias confirmadas', color: C.barraFuerte, valores: asis }, { label: 'Sin confirmar', color: C.barraSuave, valores: rec.map((r, i) => (r == null ? null : Math.max(0, r - (asis[i] || 0)))) }] });
  }
  for (const k of ['ventas', 'leads', 'cobros', 'usuarios', 'visitas']) {
    const v = s(k);
    if (tiene(v) && graficos.length < 4) graficos.push({ eyebrow: require('./analisis').METRICAS[k].label + ' por mes', titulo: `${num(total(v))} ${require('./analisis').METRICAS[k].corto}`, series: [{ label: require('./analisis').METRICAS[k].label, color: C.barraFuerte, valores: v }] });
  }
  return { kpis: kpis.slice(0, 4), graficos };
}

function tituloTurnos(meses, bot, totalT) {
  const i = meses.length - 1;
  if (totalT[i] && bot[i]) {
    const r = bot[i] / totalT[i];
    const frase = r >= 0.6 ? '2 de cada 3' : r >= 0.45 ? '1 de cada 2' : r >= 0.3 ? '1 de cada 3' : `el ${Math.round(r * 100)} %`;
    return `En ${mesLargo(meses[i])}, el bot dio ${frase} turnos`;
  }
  return `${num(total(bot))} turnos dados por el bot`;
}

function tituloConversaciones(meses, conv, bot) {
  const pcts = conv.map((t, i) => (t ? Math.round(100 * (bot[i] || 0) / t) : null)).filter(v => v != null);
  if (pcts.length >= 2 && pcts[pcts.length - 1] - pcts[0] >= 3) return `De ${pcts[0]} % a ${pcts[pcts.length - 1]} % de conversaciones resueltas por el bot`;
  const pct = total(conv) ? Math.round(10 * total(bot) / total(conv)) : 0;
  return pct ? `${pct} de cada 10 conversaciones, resueltas por el bot` : 'Conversaciones con pacientes';
}

// ── Piezas de dibujo ──
function marca(doc, x, y, tam, color) {
  doc.font('Helvetica').fontSize(tam).fillColor(color);
  const w1 = doc.widthOfString('consultoría');
  doc.text('consultoría', x, y, { lineBreak: false });
  doc.font('Helvetica-Bold').text('digital', x + w1, y, { lineBreak: false });
  return w1 + doc.widthOfString('digital');
}

function marcaDerecha(doc, xDerecha, y, tam, color) {
  doc.font('Helvetica').fontSize(tam);
  const w1 = doc.widthOfString('consultoría');
  doc.font('Helvetica-Bold');
  const w2 = doc.widthOfString('digital');
  marca(doc, xDerecha - w1 - w2, y, tam, color);
}

function pie(doc, cliente, periodo, oscuro) {
  const color = oscuro ? C.grisClaro : '#7a8893';
  doc.moveTo(M, H - 44).lineTo(W - M, H - 44).lineWidth(0.6).strokeColor(oscuro ? '#1d4a63' : C.borde).stroke();
  doc.font('Helvetica').fontSize(8).fillColor(color).text(`Análisis de resultados · ${cliente.nombre} · ${periodo}`, M, H - 32, { lineBreak: false });
  marcaDerecha(doc, W - M, H - 34, 11, oscuro ? C.lima : C.tinta);
}

function eyebrow(doc, texto, x, y, color) {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(color).text(texto.toUpperCase(), x, y, { characterSpacing: 1.6, lineBreak: false });
}

function fondo(doc, color) { doc.rect(0, 0, W, H).fill(color); }

function graficoBarras(doc, g, meses, x, y, w, h) {
  eyebrow(doc, g.eyebrow, x, y + 26, '#7a8893');
  doc.font('Helvetica-Bold').fontSize(15).fillColor(C.tinta).text(g.titulo, x, y, { width: w, lineBreak: false, ellipsis: true });
  const top = y + 52, alto = h - 52 - 34, base = top + alto;
  const totales = meses.map((_, i) => g.series.reduce((a, s) => a + (s.valores[i] || 0), 0));
  const max = Math.max(1, ...totales);
  // Tope "redondo" del eje: el primer escalón × 10^n que deja un 10 % de aire sobre el máximo.
  const potencia = Math.pow(10, Math.floor(Math.log10(max)));
  const tope = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(f => f * potencia).find(v => v >= max * 1.1) || 10 * potencia;
  const ejeX = x + 34, ancho = w - 34;
  doc.font('Helvetica').fontSize(6.5).fillColor('#8a97a1');
  for (let k = 0; k <= 4; k++) {
    const v = tope * k / 4, yy = base - alto * k / 4;
    doc.moveTo(ejeX, yy).lineTo(x + w, yy).lineWidth(0.4).strokeColor('#dde3e7').stroke();
    doc.fillColor('#8a97a1').text(num(v), x, yy - 3, { width: 28, align: 'right', lineBreak: false });
  }
  const slot = ancho / meses.length, bw = Math.min(46, slot * 0.6);
  meses.forEach((mes, i) => {
    const bx = ejeX + slot * i + (slot - bw) / 2;
    let acumulado = 0;
    g.series.forEach((s, si) => {
      const v = s.valores[i] || 0;
      if (!v) return;
      const bh = alto * v / tope;
      const by = base - alto * acumulado / tope - bh;
      doc.rect(bx, by, bw, Math.max(0.5, bh)).fill(s.color);
      if (si === 0 && g.series.length > 1 && bh > 16) {
        doc.font('Helvetica').fontSize(7).fillColor(C.blanco).text(num(v), bx, by + bh / 2 - 3, { width: bw, align: 'center', lineBreak: false });
      }
      acumulado += v;
    });
    if (totales[i]) {
      const ty = base - alto * totales[i] / tope - 11;
      const etiqueta = g.porcentaje && g.porcentaje[i] != null ? g.porcentaje[i] + ' %' : num(totales[i]);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.tinta).text(etiqueta, bx - 10, ty, { width: bw + 20, align: 'center', lineBreak: false });
    }
    doc.font('Helvetica').fontSize(7).fillColor('#8a97a1').text(mesCorto(mes), bx - 10, base + 6, { width: bw + 20, align: 'center', lineBreak: false });
  });
  let lx = x;
  const ly = base + 22;
  for (const s of g.series) {
    doc.circle(lx + 4, ly + 4, 4).fill(s.color);
    doc.font('Helvetica').fontSize(8).fillColor(C.texto).text(s.label, lx + 12, ly, { lineBreak: false });
    lx += 22 + doc.widthOfString(s.label) + 14;
  }
}

function construirPdf({ cliente, desde, hasta, meses, categorias, notas, analisis }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [W, H], margin: 0, info: { Title: `Análisis · ${cliente.nombre}`, Author: 'Consultoría Digital' } });
    const partes = [];
    doc.on('data', b => partes.push(b));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);
    const periodo = periodoTexto(desde, hasta);
    const { kpis, graficos } = armarIndicadores(cliente, meses);
    const categoria = categorias[cliente.categoria] || 'Proyecto';

    // 1. Portada
    fondo(doc, C.noche);
    doc.font('Helvetica-Bold').fontSize(22).fillColor(C.blanco).text(cliente.nombre, M, 50, { width: 520, lineBreak: false, ellipsis: true });
    doc.font('Helvetica').fontSize(9).fillColor(C.grisClaro).text(categoria, M, 78, { lineBreak: false });
    doc.font('Helvetica').fontSize(7.5).fillColor(C.grisClaro).text('Un trabajo de', W - M - 200, 46, { width: 200, align: 'right', lineBreak: false });
    marcaDerecha(doc, W - M, 58, 17, C.lima);
    eyebrow(doc, 'Análisis de resultados', M, 196, C.lima);
    const titular = kpis[0] ? `${kpis[0].valor} ${kpis[0].texto}` : `Resultados de ${periodo}`;
    doc.font('Helvetica-Bold').fontSize(34).fillColor(C.blanco).text(titular.charAt(0).toUpperCase() + titular.slice(1), M, 218, { width: 700, lineGap: 2 });
    const yPill = Math.min(doc.y + 18, 390);
    doc.font('Helvetica').fontSize(9.5);
    const pill = `Datos de ${periodo}`;
    const pw = doc.widthOfString(pill) + 30;
    doc.roundedRect(M, yPill, pw, 26, 13).lineWidth(0.8).strokeColor(C.lima).stroke();
    doc.fillColor(C.lima).text(pill, M, yPill + 8, { width: pw, align: 'center', lineBreak: false });
    if (cliente.descripcion) doc.font('Helvetica').fontSize(11).fillColor(C.grisClaro).text(cliente.descripcion, M, yPill + 48, { width: 600, lineGap: 3 });

    // 2. En números
    if (kpis.length) {
      doc.addPage();
      fondo(doc, C.noche);
      eyebrow(doc, 'En números', M, 52, C.lima);
      doc.font('Helvetica-Bold').fontSize(26).fillColor(C.blanco).text(`${cliente.nombre}, ${periodo}`, M, 68, { width: W - 2 * M, lineBreak: false, ellipsis: true });
      const gap = 18, cw = (W - 2 * M - gap * (kpis.length - 1)) / kpis.length;
      kpis.forEach((k, i) => {
        const cx = M + i * (cw + gap);
        doc.roundedRect(cx, 130, cw, 128, 8).fill(C.tarjeta);
        doc.font('Helvetica-Bold').fontSize(kpis.length > 3 ? 30 : 36).fillColor(C.lima).text(k.valor, cx + 18, 150, { width: cw - 36, lineBreak: false, ellipsis: true });
        doc.font('Helvetica').fontSize(9.5).fillColor(C.grisClaro).text(k.texto, cx + 18, 200, { width: cw - 36, lineGap: 2, height: 52, ellipsis: true });
      });
      doc.font('Helvetica').fontSize(8).fillColor(C.grisClaro).text('Cifras tomadas de los sistemas en producción del cliente, sin datos personales.', M, H - 66, { lineBreak: false });
      pie(doc, cliente, periodo, true);
    }

    // 3. Resultados: gráficos de a dos por página
    for (let i = 0; i < graficos.length; i += 2) {
      doc.addPage();
      fondo(doc, C.papel);
      eyebrow(doc, 'Resultados', M, 52, '#1d4a63');
      const par = graficos.slice(i, i + 2);
      const gw = par.length === 2 ? (W - 2 * M - 48) / 2 : W - 2 * M;
      par.forEach((g, j) => graficoBarras(doc, g, meses, M + j * (gw + 48), 82, gw, 330));
      const fuente = notas.length ? 'Fuente: ' + notas.join(' ') : 'Fuente: registros del sistema del cliente y del asistente.';
      doc.font('Helvetica').fontSize(7.5).fillColor('#7a8893').text(fuente, M, H - 82, { width: W - 2 * M, lineGap: 2, height: 32, ellipsis: true });
      pie(doc, cliente, periodo, false);
    }

    if (!kpis.length && !graficos.length) {
      doc.addPage();
      fondo(doc, C.papel);
      eyebrow(doc, 'Resultados', M, 52, '#1d4a63');
      doc.font('Helvetica-Bold').fontSize(20).fillColor(C.tinta).text('Todavía no hay números cargados para este período.', M, 90, { width: W - 2 * M });
      pie(doc, cliente, periodo, false);
    }

    // 4. Análisis y próximos pasos
    if (analisis && analisis.trim()) {
      doc.addPage();
      fondo(doc, C.noche);
      eyebrow(doc, 'Análisis y próximos pasos', M, 120, C.lima);
      doc.font('Helvetica-Bold').fontSize(26).fillColor(C.blanco).text('Lo que vemos y lo que sigue', M, 138, { width: 600 });
      doc.font('Helvetica').fontSize(12).fillColor(C.grisClaro).text(analisis.trim(), M, 192, { width: 640, lineGap: 5, height: 270, ellipsis: true });
      pie(doc, cliente, periodo, true);
    }

    doc.end();
  });
}

module.exports = { construirPdf, armarIndicadores, periodoTexto };
