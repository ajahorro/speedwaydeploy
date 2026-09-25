const { GoogleGenerativeAI } = require('@google/generative-ai');

const geminiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(geminiKey);
let availableModelsCache = { expiresAt: 0, names: [] };

const cleanJson = (text) => text
  .replace(/^```json\s*/i, '')
  .replace(/^```\s*/i, '')
  .replace(/\s*```$/i, '')
  .trim();

const parseJsonResponse = (text) => {
  const cleaned = cleanJson(text);
  try { return JSON.parse(cleaned); } catch {
    const objectStart = cleaned.indexOf('{');
    const objectEnd = cleaned.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) return JSON.parse(cleaned.slice(objectStart, objectEnd + 1));
    throw new Error('OCR model returned non-JSON text');
  }
};

/**
 * Reads a receipt with a cascading Gemini fallback. A model-level failure
 * (unavailable model, quota, timeout, or malformed result) advances to the
 * next model without exposing the API key or raw receipt to the client.
 *
 * OCR IS A SOURCE OF TRUTH for several downstream flows (payment verification,
 * financial ledger, booking confirmation), so this routine is deliberately
 * resilient: it discovers models at runtime, tries EVERY operational candidate,
 * and only fails once all of them have been exhausted.
 *
 * 🛠️ HOTFIX (Gross vs Net fee deduction):
 * E-wallet / cross-bank receipts show a GROSS total the customer sent (e.g.
 * ₱1,110) plus a separate "Transfer Fee" / "Convenience Fee" line (e.g. ₱30).
 * The shop only RECEIVES the net (₱1,080). Comparing the gross against the
 * expected amount produced false NAME_MISMATCH/amount-mismatch failures and
 * overstated the ledger. The prompt now demands the fee AND the net, and the
 * caller enforces `net === gross - fee` itself rather than trusting the model.
 */
async function processReceiptOCR(imageBuffer, mimeType = 'image/jpeg') {
  if (!geminiKey) throw new Error('GEMINI_API_KEY is not configured');

  const prompt = `Analyze this proof of payment (GCash / bank / e-wallet receipt) very carefully.
Return ONLY a valid JSON object with these exact keys:
  amount (number or null)          -> the NET amount the RECIPIENT actually received
  grossAmount (number or null)     -> the total the sender PAID (before any fee)
  transferFee (number or null)     -> any 'Transfer Fee', 'Convenience Fee', 'Service Fee', 'InstaPay/PESONet fee' line item, else 0
  referenceNumber (string or null) -> the transaction reference / trace number
  timestamp (string or null)       -> the payment date/time printed on the receipt
  isValidReceipt (boolean)
  recipient (string or null)       -> the account NAME that received the money
  description (string or null)

CRITICAL RULES:
1. If you detect a 'Transfer Fee' or 'Convenience Fee' line item, you MUST subtract that fee from the Total Paid. The 'amount' you return MUST be the NET amount received by the shop, NOT the gross amount paid by the customer.
2. amount = grossAmount - transferFee (when a fee exists). If no fee line is present, amount = grossAmount and transferFee = 0.
3. Report the fee you subtracted in 'transferFee' so the ledger can show the deduction. Never leave transferFee null when a fee line is visible.
4. The timestamp must be the payment date/time printed on the receipt, not the date this scan was performed.`;
  const imagePart = { inlineData: { data: imageBuffer.toString('base64'), mimeType } };
  let lastError;
  const now = Date.now();
  if (availableModelsCache.expiresAt <= now) {
    // B3-iii: the discovery call itself must be bounded. Without an abort
    // signal a hung TLS connection to Google would block the request forever,
    // which the customer experiences as a permanently spinning upload.
    const controller = new AbortController();
    const discoveryTimeout = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(geminiKey)}`,
        { signal: controller.signal }
      );
    } catch (discoveryErr) {
      throw new Error(`Gemini model discovery failed: ${discoveryErr.message}`);
    } finally {
      clearTimeout(discoveryTimeout);
    }

    if (!response.ok) throw new Error(`Gemini model discovery failed (${response.status})`);
    const payload = await response.json();
    availableModelsCache = {
      expiresAt: now + 5 * 60 * 1000,
      names: (payload.models || [])
        .filter(model => model.name && (model.supportedGenerationMethods || []).includes('generateContent'))
        .map(model => model.name.replace(/^models\//, ''))
        // B3-i: we no longer EXCLUDE any model family. The previous
        // `!/2\.5-flash/i` filter actively dropped gemini-2.5-flash, and once
        // the older flash generations are retired the list could become empty —
        // which failed every OCR upload with 'Gemini returned no models'.
        // We keep every Gemini text/vision model that supports generateContent.
        .filter(name => /^gemini/i.test(name))
        // Exclude variants that CANNOT take an inline image. Verified live
        // against the API: a TTS model answers 400 'Image input modality is not
        // enabled for this model', and embeddings/aqa reject the request shape
        // outright. Trying these wastes a slot in the cascade.
        .filter(name => !/(embedding|aqa|tts|image-generation|imagen)/i.test(name))
        // Prefer, in order: newest flash, then flash-latest, then any flash,
        // then anything else. A stable, explicit rank keeps behaviour
        // deterministic across discovery refreshes.
        .sort((a, b) => {
          const rank = name => {
            if (/3\.6.*flash/i.test(name)) return 0;
            if (/flash-latest/i.test(name)) return 1;
            if (/3\.[0-9]+.*flash/i.test(name)) return 2;
            if (/flash/i.test(name)) return 3;
            return 4;
          };
          const diff = rank(a) - rank(b);
          // Deterministic tie-break so two equivalent models never swap order
          // between refreshes (avoids flapping which model gets tried first).
          return diff !== 0 ? diff : a.localeCompare(b);
        })
    };
    console.log(`[OCR] Discovered ${availableModelsCache.names.length} Gemini generateContent model(s): ${availableModelsCache.names.slice(0, 5).join(', ')}`);
    if (!availableModelsCache.names.length) {
      // Surface a specific, operatable error instead of a generic failure: this
      // means the API key cannot see any generateContent model (wrong key,
      // disabled API, or a region/entitlement problem).
      throw new Error('Gemini returned no models supporting generateContent (check GEMINI_API_KEY and that the Generative Language API is enabled)');
    }
  }

  // B3-ii: try EVERY discovered candidate in priority order, not just the first
  // two. A 503 / rate-limit on the preferred model must fall through to the next
  // operational one rather than failing the whole scan.
  const attempts = availableModelsCache.names;
  for (const modelName of attempts) {
    try {
      console.log(`[OCR] Attempting receipt scan with ${modelName}.`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await Promise.race([
        model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }, imagePart] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0 }
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('OCR model timeout')), 12000))
      ]);
      const rawText = (await result.response).text();
      const parsed = parseJsonResponse(rawText);

      console.log(`[OCR] Receipt scan succeeded with ${modelName}.`);

      // 🛠️ HOTFIX — ENFORCE the net = gross − fee arithmetic OURSELVES.
      //
      // The LLM is instructed to return the NET amount, but a model can still
      // hand back the gross total (this was the ₱1,110-vs-₱980 failure). We do
      // not trust it: whenever a fee was detected we recompute the net from the
      // gross and the fee, so the value that reaches the ledger is always the
      // money the shop actually received. Only when the model returns NEITHER a
      // gross nor a fee do we fall back to its `amount`.
      const toNum = (value) => {
        const n = Number(String(value ?? '').replace(/[^0-9.]/g, ''));
        return Number.isFinite(n) ? n : null;
      };
      const parsedAmount = toNum(parsed.amount);
      const parsedGross = toNum(parsed.grossAmount ?? parsed.gross_amount ?? parsed.totalPaid ?? parsed.total);
      const parsedFee = toNum(parsed.transferFee ?? parsed.transfer_fee ?? parsed.fee);

      const fee = parsedFee !== null && parsedFee > 0 ? parsedFee : 0;
      const gross = parsedGross !== null && parsedGross > 0
        ? parsedGross
        : (parsedAmount !== null ? parsedAmount + fee : null);
      // The authoritative NET the shop receives.
      const netAmount = gross !== null
        ? Math.max(0, Math.round((gross - fee) * 100) / 100)
        : parsedAmount;

      if (fee > 0) {
        console.log(`[OCR] Fee deduction applied: gross ₱${gross} − fee ₱${fee} = net ₱${netAmount}`);
      }

      return {
        amount: netAmount,
        grossAmount: gross,
        transferFee: fee,
        referenceNumber: parsed.referenceNumber ?? parsed.referenceNo ?? null,
        timestamp: parsed.timestamp ?? parsed.date ?? null,
        isValidReceipt: Boolean(parsed.isValidReceipt ?? parsed.isReceipt),
        recipient: parsed.recipient ?? null,
        description: parsed.description ?? null,
        modelName
      };
    } catch (error) {
      lastError = error;
      console.warn(`[OCR] ${modelName} failed: ${error.message}`);
    }
  }

  const unavailableError = new Error(`ALL_MODELS_FAILED: ${lastError?.message || 'Unknown OCR failure'}`);
  unavailableError.cause = lastError;
  throw unavailableError;
}

module.exports = { processReceiptOCR };
