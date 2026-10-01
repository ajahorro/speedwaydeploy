const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');
const { parseReceiptText } = require('./receiptTextParser');

const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_WIDTH = 1000;
const MAX_IMAGE_HEIGHT = 1000;
const WORKER_INIT_TIMEOUT_MS = 20000;
const RECOGNITION_TIMEOUT_MS = 7000;
const TESSERACT_CACHE_PATH = path.join(os.tmpdir(), 'speedway-tesseract');
fs.mkdirSync(TESSERACT_CACHE_PATH, { recursive: true });
let workerPromise;

const startTiming = (label) => {
  const startedAt = process.hrtime.bigint();
  console.info(`[OCR TIMING] ${label} start`);
  return () => {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.info(`[OCR TIMING] ${label} end (${elapsedMs.toFixed(1)}ms)`);
  };
};

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
    const finishTiming = startTiming('worker initialization');
    const initialization = createWorker('eng', 1, { cachePath: TESSERACT_CACHE_PATH });
    let pending;
    pending = withTimeout(initialization, WORKER_INIT_TIMEOUT_MS, 'OCR worker initialization')
      .then((worker) => {
        finishTiming();
        return worker;
      })
      .catch((error) => {
        finishTiming();
        void initialization.then((worker) => worker.terminate()).catch(() => {});
        if (workerPromise === pending) workerPromise = null;
        throw error;
      });
    workerPromise = pending;
  }
  return workerPromise;
};

const warmReceiptOcr = () => getWorker();

const recognizeWithTesseract = async (image, passNumber) => {
  const worker = await getWorker();
  const finishTiming = startTiming(`recognition pass ${passNumber}`);
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
  } finally {
    finishTiming();
  }
};

const createBaseImage = (buffer) => sharp(buffer, {
  failOn: 'error',
  limitInputPixels: MAX_IMAGE_PIXELS,
}).rotate().resize({
  width: MAX_IMAGE_WIDTH,
  height: MAX_IMAGE_HEIGHT,
  fit: 'inside',
  withoutEnlargement: true,
});

const buildImageVariant = async (buffer, index) => {
  const finishTiming = startTiming(`preprocessing pass ${index + 1}`);
  const base = createBaseImage(buffer);
  try {
    if (index === 0) {
      return await base.clone()
        .grayscale()
        .normalize()
        .png()
        .toBuffer();
    }
    if (index === 1) {
      return await base.clone()
        .grayscale()
        .normalize()
        .linear(1.20, -10)
        .threshold(170)
        .png()
        .toBuffer();
    }
    throw new RangeError(`Unknown receipt preprocessing pass: ${index + 1}`);
  } finally {
    finishTiming();
  }
};

const buildImageVariants = async (buffer) => {
  const variants = [];
  for (let index = 0; index < 2; index += 1) {
    variants.push(await buildImageVariant(buffer, index));
  }
  return variants;
};

const scoreResult = (parsed, confidence) => (
  (parsed.isValidReceipt ? 2 : 0)
  + (parsed.amount !== null ? 4 : 0)
  + (parsed.recipient ? 2 : 0)
  + (parsed.referenceNumber ? 1 : 0)
  + Math.max(0, Math.min(100, confidence)) / 100
);

const hasCoreFields = (parsed) => (
  parsed.isValidReceipt
  && parsed.amount !== null
  && parsed.recipient !== null
);

const hasStrongCandidate = (parsed, candidate) => (
  Number(candidate?.confidence ?? 0) >= 78
  && parsed.amount !== null
  && parsed.recipient !== null
  && (parsed.referenceNumber || '').trim().length > 0
);

const createReceiptOcr = ({
  recognize = recognizeWithTesseract,
  buildVariant = buildImageVariant,
} = {}) => async (buffer, { validateCandidate = hasCoreFields } = {}) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('A non-empty receipt image is required.');
  }

  const finishTiming = startTiming('complete OCR scan');
  let best = null;
  try {
    const maxPasses = 1;
    for (let index = 0; index < maxPasses; index += 1) {
      const variant = await buildVariant(buffer, index);
      const { text, confidence } = await recognize(variant, index + 1);
      const parsed = parseReceiptText(text);
      const candidate = {
        ...parsed,
        confidence,
        ocrPass: index + 1,
        score: scoreResult(parsed, confidence),
      };

      if (!best || candidate.score > best.score) best = candidate;
      if (validateCandidate(parsed, candidate)) {
        best = candidate;
        break;
      }

      // Fast path: if the first pass already produced a strong candidate we stop
      // instead of spending another recognition cycle on fallback work.
      if (index === 0 && hasStrongCandidate(parsed, candidate)) {
        best = candidate;
        break;
      }
    }

    const { score, ...result } = best;
    return result;
  } finally {
    finishTiming();
  }
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
  warmReceiptOcr,
  stopReceiptOcr,
  createReceiptOcr,
  buildImageVariant,
  buildImageVariants,
  scoreResult,
};