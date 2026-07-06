const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const LOGO_PATH = path.join(__dirname, 'public', 'assets', 'logo.png');
const LOGO_ASPECT = 1476 / 3300; // height/width of public/assets/logo.png

// Builds a branded Estimate/Invoice PDF and returns the (already-ended)
// PDFDocument — a readable stream safe to .pipe() into an HTTP response or
// collect into a Buffer via pdfBufferFromDoc() below.
//
// items: [{ description, qty, unitPrice }] — unitPrice covers both invoice
// line items and purchase-request items (callers normalize estUnitCost to
// unitPrice before calling). Only description/qty/unitPrice are ever drawn —
// internal-purchasing-only fields (vendor/sku/url) never reach this renderer,
// so they can't accidentally end up on a client-facing PDF.
function renderDocumentPdf({ kind, number, clientName, preparedBy, items, notes, taxRate, dueDate, orgName }) {
  const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
  const leftX = doc.page.margins.left;
  const rightEdge = doc.page.width - doc.page.margins.right;
  const contentWidth = rightEdge - leftX;
  const topY = doc.page.margins.top;

  // Header: info block on the left, logo on the right — matches the
  // reference estimate's layout and avoids the two overlapping vertically.
  const logoWidth = 160;
  const logoHeight = logoWidth * LOGO_ASPECT;
  const logoX = rightEdge - logoWidth;
  const headerTextWidth = logoX - leftX - 20;

  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, logoX, topY, { width: logoWidth });
  }

  doc.fontSize(18).font('Helvetica-Bold').fillColor('#111').text(kind, leftX, topY, { width: headerTextWidth });
  doc.fontSize(10).font('Helvetica').fillColor('#333');
  doc.text(`${kind} Number: ${number}`, leftX, doc.y + 8, { width: headerTextWidth });
  if (clientName) doc.text(`Prepared For: ${clientName}`, leftX, doc.y, { width: headerTextWidth });
  if (preparedBy) doc.text(`Prepared By: ${preparedBy}`, leftX, doc.y, { width: headerTextWidth });
  if (kind === 'Invoice' && dueDate) doc.text(`Due Date: ${new Date(dueDate).toLocaleDateString()}`, leftX, doc.y, { width: headerTextWidth });

  doc.y = Math.max(doc.y, topY + logoHeight) + 24;
  doc.x = leftX;

  doc.fontSize(9).font('Helvetica-Oblique').fillColor('#555').text(
    kind === 'Estimate'
      ? `Thank you for the opportunity to provide this estimate. Please review the items below${orgName ? ` from ${orgName}` : ''} and use the Approve/Deny buttons on this page to respond.`
      : `Thank you for your business${orgName ? ` from ${orgName}` : ''}. Please remit payment by the due date above.`,
    { width: contentWidth }
  );
  doc.font('Helvetica').fillColor('#000');
  doc.moveDown(1.2);

  // Table — pdfkit has no built-in table primitive, columns are laid out by hand.
  const col = {
    desc:  { x: leftX, width: contentWidth - 220 },
    qty:   { x: leftX + contentWidth - 220, width: 50 },
    price: { x: leftX + contentWidth - 170, width: 80 },
    total: { x: leftX + contentWidth - 90,  width: 90 },
  };
  const rowHeight = 20;

  function drawTableHeader() {
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#000');
    const headerY = doc.y;
    doc.text('Description', col.desc.x, headerY, { width: col.desc.width });
    doc.text('Qty', col.qty.x, headerY, { width: col.qty.width, align: 'right' });
    doc.text('Unit Price', col.price.x, headerY, { width: col.price.width, align: 'right' });
    doc.text('Total', col.total.x, headerY, { width: col.total.width, align: 'right' });
    doc.y = headerY + 14;
    doc.x = leftX;
    doc.moveTo(leftX, doc.y).lineTo(rightEdge, doc.y).strokeColor('#ccc').stroke();
    doc.y += 8;
    doc.x = leftX;
    doc.font('Helvetica').fillColor('#000');
  }

  function ensureRoom(neededHeight) {
    if (doc.y + neededHeight > doc.page.height - doc.page.margins.bottom - 80) {
      doc.addPage();
      doc.y = doc.page.margins.top;
      drawTableHeader();
    }
  }

  drawTableHeader();

  let grandTotal = 0;
  for (const item of (items || [])) {
    const qty = Number(item.qty) || 0;
    const price = Number(item.unitPrice) || 0;
    const lineTotal = qty * price;
    grandTotal += lineTotal;

    ensureRoom(rowHeight);
    const rowY = doc.y;
    doc.fontSize(9);
    doc.text(item.description || '', col.desc.x, rowY, { width: col.desc.width });
    doc.text(String(qty), col.qty.x, rowY, { width: col.qty.width, align: 'right' });
    doc.text('$' + price.toFixed(2), col.price.x, rowY, { width: col.price.width, align: 'right' });
    doc.text('$' + lineTotal.toFixed(2), col.total.x, rowY, { width: col.total.width, align: 'right' });
    doc.y = rowY + rowHeight;
  }

  let finalTotal = grandTotal;
  ensureRoom(70);
  doc.moveDown(0.5);
  if (taxRate) {
    const tax = grandTotal * (taxRate / 100);
    finalTotal = grandTotal + tax;
    doc.fontSize(9).text(`Subtotal: $${grandTotal.toFixed(2)}`, col.price.x - 40, doc.y, { width: col.total.width + 40, align: 'right' });
    doc.moveDown(0.3);
    doc.text(`Tax (${taxRate}%): $${tax.toFixed(2)}`, col.price.x - 40, doc.y, { width: col.total.width + 40, align: 'right' });
    doc.moveDown(0.5);
  }

  const totalBoxWidth = 220;
  const totalBoxX = rightEdge - totalBoxWidth;
  doc.rect(totalBoxX, doc.y - 4, totalBoxWidth, 24).fill('#fdf6d8');
  doc.fillColor('#000').fontSize(11).font('Helvetica-Bold')
    .text(`Total: $${finalTotal.toFixed(2)}`, totalBoxX + 10, doc.y, { width: totalBoxWidth - 20, align: 'right' });
  doc.font('Helvetica').fillColor('#000');
  doc.x = leftX;
  doc.moveDown(2);

  if (notes) {
    ensureRoom(60);
    doc.x = leftX;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#555').text('Notes', leftX, doc.y, { width: contentWidth });
    doc.font('Helvetica').fillColor('#000').text(notes, leftX, doc.y + 4, { width: contentWidth });
  }

  doc.end();
  return doc;
}

// Collects a PDFDocument's stream output into a Buffer (used when the PDF
// needs to be base64-encoded and pushed to SA-Website, rather than streamed
// straight to an HTTP response).
function pdfBufferFromDoc(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

module.exports = { renderDocumentPdf, pdfBufferFromDoc };
