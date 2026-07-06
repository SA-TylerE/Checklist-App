const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const LOGO_PATH = path.join(__dirname, 'public', 'assets', 'logo.png');
const LOGO_ASPECT = 1476 / 3300; // height/width of public/assets/logo.png
const APPROVAL_EMAIL = 'approval@systemalternatives.net';
const APPROVAL_PHONE = '503-878-8000';

// Builds a branded Estimate/Invoice PDF and returns the (already-ended)
// PDFDocument — a readable stream safe to .pipe() into an HTTP response or
// collect into a Buffer via pdfBufferFromDoc() below.
//
// items: [{ name, description, qty, unitPrice }] — `name` is optional (Item
// column only appears if at least one item has one); unitPrice covers both
// invoice line items and purchase-request items (callers normalize
// estUnitCost to unitPrice before calling). vendor/sku/url (internal-
// purchasing-only fields) never reach this renderer, so they can't
// accidentally end up on a client-facing PDF.
//
// signature (optional): { decision, resolvedAtIso, resolvedBy, ip, verificationId }
// — when present (only once a Purchase Request has actually been approved or
// denied), stamps an audit block at the bottom. This is an e-signature-style
// record (who/when/from where + a tamper-evident verification id), not a
// cryptographic PKI signature.
function renderDocumentPdf({ kind, number, clientName, preparedBy, items, notes, taxRate, dueDate, orgName, signature }) {
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

  if (kind === 'Estimate') {
    doc.fontSize(9).font('Helvetica-Oblique').fillColor('#333').text(
      'Thank you for the opportunity to provide an estimate for your project. We have done our best to give you a '
      + 'realistic idea about what your project will cost. Although our estimates are generally accurate we can not '
      + 'forsee every circumstance related to your specific environment. If the project scope changes or if we run '
      + 'into unanticipated costs we will let you know as soon as possible.',
      { width: contentWidth }
    );
    doc.moveDown(0.5);
    doc.x = leftX;
    doc.font('Helvetica-BoldOblique').fillColor('#333')
      .text('Please review and sign this document and send it back to ', { continued: true, width: contentWidth });
    doc.fillColor('#2563eb')
      .text(APPROVAL_EMAIL, { continued: true, link: `mailto:${APPROVAL_EMAIL}`, underline: true });
    doc.fillColor('#333')
      .text(` or give us a call at ${APPROVAL_PHONE}.`);
  } else {
    doc.fontSize(9).font('Helvetica-Oblique').fillColor('#555').text(
      `Thank you for your business${orgName ? ` from ${orgName}` : ''}. Please remit payment by the due date above.`,
      { width: contentWidth }
    );
  }
  doc.font('Helvetica').fillColor('#000');
  doc.x = leftX;
  doc.moveDown(1.2);

  // Table — pdfkit has no built-in table primitive, columns are laid out by
  // hand. The "Item" column only appears when at least one item has a name
  // (purchase-request items repurpose their SKU/part# field as this).
  const showItemCol = (items || []).some(it => it.name);
  const itemColWidth = showItemCol ? 90 : 0;
  const itemColGap = showItemCol ? 10 : 0;
  const col = {
    item:  { x: leftX, width: itemColWidth },
    desc:  { x: leftX + itemColWidth + itemColGap, width: contentWidth - itemColWidth - itemColGap - 220 },
    qty:   { x: leftX + contentWidth - 220, width: 50 },
    price: { x: leftX + contentWidth - 170, width: 80 },
    total: { x: leftX + contentWidth - 90,  width: 90 },
  };
  const rowHeight = 20;

  function drawTableHeader() {
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#000');
    const headerY = doc.y;
    if (showItemCol) doc.text('Item', col.item.x, headerY, { width: col.item.width });
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
    if (showItemCol) doc.text(item.name || '', col.item.x, rowY, { width: col.item.width });
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

  if (signature) {
    ensureRoom(90);
    doc.x = leftX;
    doc.moveDown(1.5);
    const boxY = doc.y;
    const boxHeight = 80;
    const approved = signature.decision === 'approved';
    doc.rect(leftX, boxY, contentWidth, boxHeight)
      .fillAndStroke(approved ? '#f0fdf4' : '#fef2f2', approved ? '#86efac' : '#fca5a5');
    doc.fillColor(approved ? '#166534' : '#991b1b').fontSize(11).font('Helvetica-Bold')
      .text(approved ? 'ELECTRONICALLY APPROVED' : 'ELECTRONICALLY DENIED', leftX + 14, boxY + 10);
    doc.fillColor('#333').fontSize(9).font('Helvetica');
    doc.text(`By: ${signature.resolvedBy || ''}`, leftX + 14, boxY + 30);
    doc.text(`Date: ${signature.resolvedAtIso || ''}`, leftX + 14, doc.y);
    doc.text(`IP Address: ${signature.ip || ''}`, leftX + 14, doc.y);
    doc.text(`Verification ID: ${signature.verificationId || ''}`, leftX + 14, doc.y);
    doc.fillColor('#000');
    doc.y = boxY + boxHeight + 10;
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
