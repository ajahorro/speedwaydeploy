const assert = require('assert');
const sharp = require('../backend/node_modules/sharp');
const { recognizeReceipt, createReceiptOcr, buildImageVariants, stopReceiptOcr } = require('../backend/services/receiptOcr');

const sampleSvg = Buffer.from(
  '<svg width="640" height="400" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="24" y="80" font-size="32">GCash receipt</text></svg>'
);

(async () => {
  const image = await sharp(sampleSvg).png().toBuffer();
  const variants = await buildImageVariants(image);
  assert.strictEqual(variants.length, 3, 'the pipeline should provide three bounded preprocessing passes');
  for (const variant of variants) {
    const metadata = await sharp(variant).metadata();
    assert.strictEqual(metadata.format, 'png');
    assert.ok(metadata.width <= 2400 && metadata.height <= 3200);
  }

  let passes = 0;
  const recognize = createReceiptOcr({
    recognize: async () => {
      passes += 1;
      return {
        text: passes === 1
          ? 'GCash\nTotal Amount Sent\nP2,500.00'
          : 'GCash\nSent to COMAR GARAGE\nTotal Amount Sent\nP2,500.00\nRef 902133488721\nJan 15, 2025',
        confidence: passes === 1 ? 95 : 80,
      };
    },
  });

  const result = await recognize(image);
  assert.strictEqual(passes, 2, 'retry when the first pass is missing core receipt fields');
  assert.strictEqual(result.amount, 2500);
  assert.strictEqual(result.recipient, 'COMAR GARAGE');
  assert.strictEqual(result.timestamp, '2025-01-15');
  assert.strictEqual(result.ocrPass, 2);

  if (process.env.OCR_REAL_SMOKE === '1') {
    const lines = [
      'GCash Payment Receipt',
      'Sent to COMAR GARAGE',
      'Total Amount Sent',
      'P2,500.00',
      'Reference No 9021334887221',
      'Sep 30, 2026',
    ];
    const textSvg = lines.map((line, index) => (
      `<text x="70" y="${120 + index * 120}" font-family="Arial" font-size="64">${line}</text>`
    )).join('');
    const receipt = await sharp(Buffer.from(
      `<svg width="1200" height="900" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/>${textSvg}</svg>`
    )).png().toBuffer();
    try {
      const realResult = await recognizeReceipt(receipt);
      assert.strictEqual(realResult.amount, 2500);
      assert.strictEqual(realResult.recipient, 'COMAR GARAGE');
      assert.strictEqual(realResult.referenceNumber, '9021334887221');
      console.log(`PASS  real Tesseract smoke (confidence ${realResult.confidence}, pass ${realResult.ocrPass})`);
    } finally {
      await stopReceiptOcr();
    }
  }

  console.log('PASS  server OCR preprocessing and multi-pass selection');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});