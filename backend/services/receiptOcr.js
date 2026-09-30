const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');
const { parseReceiptText } = require('./receiptTextParser');

const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_WIDTH = 2400;
const MAX_IMAGE_HEIGHT = 3200;
const WORKER_INIT_TIMEOUT_MS = 45000;
const RECOGNITION_TIMEOUT_MS = 25000;
const TESSERACT_CACHE_PATH = path.join(os.tmpdir(), 'speedway-tesseract');
fs.mkdirSync(TESSERACT_CACHE_PATH, { recursive: true });
let workerPromise;

const withTimeout = (promise, timeoutMs, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
};

const getWorker = () => {
  if (!workerPromise) {
    const initialization = createWorker('eng', 1, { cachePath: TESSERACT_CACHE_PATH });
    let pending;
    pending = withTimeout(initialization, WORKER_INIT_TIMEOUT_MS, 'OCR worker initialization').catch((error) => {
      void initialization.then((worker) => worker.terminate()).catch(() => {});
      if (workerPromise === pending) workerPromise = null;
      throw error;
    });
    workerPromise = pending;
  }
  return workerPromise;
};

const recognizeWithTesseract = async (image) => {
  const worker = await getWorker();
  try {
    const { data } = await withTimeout(worker.recognize(image), RECOGNITION_TIMEOUT_MS, 'OCR recognition');
    return { text: data?.text || '', confidence: Number(data?.confidence) || 0 };
  } catch (error) {
    if (/timed out/.test(error.message || '')) {
      if (workerPromise) {
        workerPromise = null;
        void worker.terminate().catch(() => {});
      }
    }
    throw error;
  }
};

const createBaseImage = (buffer) => sharp(buffer, {
  failOn: 'error',
  limitInputPixels: MAX_IMAGE_PIXELS,
}).rotate().resize({
  width: MAX_IMAGE_WIDTH,
  height: MAX_IMAGE_HEIGHT,
  fit: 'inside',
  withoutEnlargement: false,
});

const buildImageVariants = async (buffer) => {
  const base = createBaseImage(buffer);
  const normalized = await base.clone()
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toBuffer();
  const thresholded = await base.clone()
    .grayscale()
    .normalize()
    .linear(1.35, -18)
    .threshold(155)
    .png()
    .toBuffer();
  const inverted = await base.clone()
    .grayscale()
    .normalize()
    .linear(1.35, -18)
    .threshold(155)
    .negate()
    .png()
    .toBuffer();

  return [normalized, thresholded, inverted];
};

const scoreResult = (parsed, confidence) => (
  (parsed.isValidReceipt ? 2 : 0)
  + (parsed.amount !== null ? 4 : 0)
  + (parsed.recipient ? 2 : 0)
  + (parsed.referenceNumber ? 1 : 0)
  + (parsed.timestamp ? 1 : 0)
  + Math.max(0, Math.min(100, confidence)) / 100
);

const hasCoreFields = (parsed) => (
  parsed.isValidReceipt
  && parsed.amount !== null
  && parsed.recipient !== null
  && parsed.timestamp !== null
);

const createReceiptOcr = ({ recognize = recognizeWithTesseract } = {}) => async (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('A non-empty receipt image is required.');
  }

  const variants = await buildImageVariants(buffer);
  let best = null;

  for (let index = 0; index < variants.length; index += 1) {
    const { text, confidence } = await recognize(variants[index]);
    const parsed = parseReceiptText(text);
    const candidate = {
      ...parsed,
      confidence,
      ocrPass: index + 1,
      score: scoreResult(parsed, confidence),
    };

    if (!best || candidate.score > best.score) best = candidate;
    if (hasCoreFields(parsed)) break;
  }

  const { score, ...result } = best;
  return result;
};

const recognizeReceipt = createReceiptOcr();

const stopReceiptOcr = async () => {
  if (!workerPromise) return;
  const worker = await workerPromise.catch(() => null);
  workerPromise = null;
  if (worker) await worker.terminate();
};

module.exports = {
  recognizeReceipt,
  stopReceiptOcr,
  createReceiptOcr,
  buildImageVariants,
  scoreResult,
};