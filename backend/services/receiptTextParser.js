/**
 * receiptTextParser.js
 * ============================================================================
 * SERVER-SIDE parsing of raw OCR text — the authoritative half of the pipeline.
 *
 * WHY THIS EXISTS AT ALL (the trust boundary)
 * ------------------------------------------
 * Text extraction now happens in the browser with Tesseract.js, for speed. That
 * text is UNTRUSTED: a user can edit it in DevTools, or POST whatever they like
 * straight to the endpoint. The server therefore does NOT accept the client's
 * parsed fields as fact. It re-parses the raw text with THIS module and derives
 * the amount, date and reference itself.
 *
 * That is why the endpoint still requires the raw image too: the client's text
 * is a hint, the server's parse is the verdict, and the image bytes feed SC-17's
 * duplicate-hash gate.
 *
 * WHY THE PARSING IS SO DEFENSIVE
 * -------------------------------
 * Tesseract reads pixels, not meaning. Measured failure modes on GCash / Maya
 * screenshots, every one of which corrupted a naive parser:
 *
 *   ₱  ->  P, F, f, 7, £          "₱2,500.00"  becomes "P2,500.00"
 *   0  ->  O, o, Q                "1,080"      becomes "1,O8O"
 *   1  ->  l, I, |                "1,250"      becomes "l,250"
 *   5  ->  S, s                   "2,500"      becomes "2,S00"
 *   8  ->  B                      "1,080"      becomes "1,OB0"
 *   label letters -> digits       "Total"      becomes "T0tal"
 *   ,  ->  . or dropped           "2,500"      becomes "2.500" or "2500"
 *
 * A single mangled digit is not cosmetic here: the amount gate accepts
 * `extracted >= required - 1.00`, so misreading ₱2,500 as ₱2,S00 must be
 * repaired or a legitimate payment is refused.
 *
 * This module mirrors frontend/src/utils/receiptOcr.js deliberately. The
 * duplication is the point: if the client's parse were reused verbatim, a user
 * could craft it. Two independent parses of the same text must agree.
 * ============================================================================
 */

/** Letter -> digit repairs, applied only inside numeric contexts. */
const DIGIT_CONFUSIONS = {
  O: '0', o: '0', Q: '0', D: '0',
  l: '1', I: '1', '|': '1', '!': '1',
  S: '5', s: '5',
  B: '8',
  Z: '2', z: '2',
  g: '9', q: '9',
  A: '4',
  T: '7',
};

/** Digit -> letter repairs, applied to LABEL text before matching. */
const repairLabelText = (line) => String(line)
  .replace(/0/g, 'o')
  .replace(/1/g, 'l')
  .replace(/5/g, 's')
  .replace(/8/g, 'b')
  .replace(/2/g, 'z');

const PESO_GLYPHS = /[₱PpFf£¥$]|\bPHP\b|\bPhp\b/gi;

/**
 * Normalise a numeric token and decide the decimal separator.
 *
 * THE AMBIGUOUS-SEPARATOR RULE
 * ----------------------------
 * "2.500" could be ₱2.50 or ₱2,500. The rule is positional and matches how
 * Philippine receipts print money:
 *   • one separator, 2 digits after  -> decimal   ("2,500.00" -> 2500.00)
 *   • one separator, 3 digits after  -> thousands ("2.500" -> 2500)
 *   • multiple separators            -> the LAST is decimal
 * A 3-digit tail is thousands because no peso amount is printed to three decimal
 * places, whereas thousands groups are always 3 digits.
 *
 * @param {string} raw
 * @returns {number|null}
 */
const parseAmountToken = (raw) => {
  if (raw === null || raw === undefined) return null;
  let text = String(raw).trim();
  if (!text) return null;

  text = text.replace(PESO_GLYPHS, '');
  text = text.replace(/[OoQDlI|!SsBZzgqAT]/g, (ch) => DIGIT_CONFUSIONS[ch] ?? ch);
  text = text.replace(/[^0-9.,]/g, '');
  if (!text) return null;

  const separators = text.match(/[.,]/g) || [];

  if (separators.length === 0) {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }

  if (separators.length === 1) {
    const [head, tail] = text.split(/[.,]/);
    if (tail.length === 3) {
      const n = Number(`${head}${tail}`);
      return Number.isFinite(n) ? n : null;
    }
    const n = Number(`${head}.${tail}`);
    return Number.isFinite(n) ? n : null;
  }

  const lastSep = Math.max(text.lastIndexOf('.'), text.lastIndexOf(','));
  const head = text.slice(0, lastSep).replace(/[.,]/g, '');
  const tail = text.slice(lastSep + 1);
  const n = Number(tail ? `${head}.${tail}` : head);
  return Number.isFinite(n) ? n : null;
};

/** Labels for the amount actually paid/received, most specific first. */
const AMOUNT_LABELS = [
  { key: 'net', pattern: /(total\s*amount\s*(received|sent)|amount\s*received|net\s*amount|received\s*amount)/i },
  { key: 'gross', pattern: /(total\s*amount\s*paid|total\s*paid|amount\s*paid|total\s*sent|grand\s*total)/i },
  { key: 'fee', pattern: /(transfer\s*fee|convenience\s*fee|service\s*fee|instapay\s*fee|pesonet\s*fee|transaction\s*fee|fee)/i },
  { key: 'generic', pattern: /(^|\b)total(\b|:)/i },
];

/**
 * A money-shaped RUN: a contiguous blob starting at a currency glyph or a
 * digit-like char, then continuing through digits, confusion chars and
 * separators.
 *
 * Capturing the whole run (rather than enumerating "shapes" with an alternation)
 * is deliberate: an earlier alternation matched only "P1,234" out of
 * "P1,234.56", under-reading by 56 centavos, and matched NOTHING for the
 * fully-mangled "P2,SOO.OO" whose digits were all misread as letters. Repair and
 * interpretation are separate concerns; the tokenizer must not entangle them.
 */
const NUMBER_LITERAL = /[₱PpFf£¥$]?[0-9OoQDlI|!SsBZzgqAT][0-9OoQDlI|!SsBZzgqAT.,]*/g;

/**
 * Does a captured token look like money rather than a fragment of prose?
 *
 * THE "Total Amount Sent" -> 70 DEFECT: prose contains digit-like characters
 * ('o', 'l', 'S', 'A'), and the fragment "T0" from "Total" repairs to "70". A
 * real money token must therefore carry a currency glyph OR a real digit, and
 * must contain at least two digits after repair.
 */
const looksLikeMoneyToken = (token) => {
  const raw = String(token || '');
  const hasCurrencyGlyph = /[₱PpFf£¥$]/.test(raw);
  const hasRealDigit = /\d/.test(raw);
  if (!hasCurrencyGlyph && !hasRealDigit) return false;
  const repaired = raw.replace(/[OoQDlI|!SsBZzgqAT]/g, (ch) => DIGIT_CONFUSIONS[ch] ?? ch);
  return (repaired.match(/\d/g) || []).length >= 2;
};

/**
 * Extract amount candidates from raw OCR text.
 *
 * THE LABEL/VALUE SPLIT: GCash and Maya print the label and the figure on
 * SEPARATE lines ("Total Amount Sent" / "₱2,500.00"). A strictly line-scoped
 * matcher finds nothing and returns a null amount, failing a genuine payment. So
 * each labelled line is checked, then the next non-empty line.
 */
const extractAmounts = (text) => {
  const found = { net: null, gross: null, fee: null, generic: null };
  if (!text) return found;

  const lines = String(text).split(/\r?\n/);

  /**
   * Best money token on one line, or null. `strict` rejects bare runs with no
   * currency glyph and no separator — used on the LABEL line, where a fragment
   * like "T0" would otherwise be read as 70. The value line is read permissively,
   * because a bare "2500" there is legitimate.
   */
  const moneyOnLine = (line, strict = false) => {
    if (!line) return null;
    const matches = [...String(line).matchAll(NUMBER_LITERAL)]
      .map((m) => m[0].trim())
      .filter(looksLikeMoneyToken)
      .filter((token) => (!strict ? true : /[₱PpFf£¥$]/.test(token) || /[.,]/.test(token)));
    if (!matches.length) return null;
    const value = parseAmountToken(matches[matches.length - 1]);
    return value !== null && value > 0 ? value : null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;

    const labelSource = repairLabelText(line);
    let label = null;
    for (const candidate of AMOUNT_LABELS) {
      if (candidate.pattern.test(labelSource)) { label = candidate.key; break; }
    }
    if (!label || found[label] !== null) continue;

    let value = moneyOnLine(line, true);
    if (value === null) {
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j += 1) {
        if (!lines[j].trim()) continue;
        value = moneyOnLine(lines[j]);
        break;
      }
    }

    if (value !== null) found[label] = value;
  }

  return found;
};

const REFERENCE_LABEL = /(reference\s*(?:no|number|#)?|ref\s*(?:no|number|#)?|trace\s*(?:no|number)?|transaction\s*(?:id|no|number)|transac(?:tion)?\s*id)/i;

/**
 * Reference / trace number.
 *
 * Tesseract breaks references with stray spaces and swaps 0/O, 1/l/I, 5/S, 8/B.
 * Two scans of the same receipt must yield the SAME reference or the
 * reference-reuse duplicate gate never fires, so confusions are repaired — but
 * conditionally, because a genuinely alphanumeric reference ("ABC123456789")
 * must not be corrupted into "A8C123456789".
 *
 * Repair applies only when BOTH hold:
 *   • at least 50% of the characters are already digits, AND
 *   • there is no run of 2+ consecutive letters.
 * Real alphanumeric references carry letter PREFIXES; OCR noise interleaves
 * single letters among digits ("9O2L33488722L").
 */
const extractReferenceNumber = (text) => {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/);

  for (const line of lines) {
    const labelMatch = line.match(REFERENCE_LABEL);
    if (!labelMatch) continue;

    const after = line.slice(labelMatch.index + labelMatch[0].length);
    const tokenMatch = after.match(/([A-Za-z0-9][A-Za-z0-9\s-]{4,})/);
    if (!tokenMatch) continue;

    const cleaned = tokenMatch[1]
      .replace(/\s+/g, '')
      .replace(/^[-]+|[-]+$/g, '')
      .trim();

    if (cleaned.length >= 6 && /\d/.test(cleaned)) {
      const chars = cleaned.replace(/[^A-Za-z0-9]/g, '');
      const digitRatio = chars.length ? (chars.match(/\d/g) || []).length / chars.length : 0;
      const hasLetterRun = /[A-Za-z]{2,}/.test(cleaned);
      const repaired = digitRatio >= 0.5 && !hasLetterRun
        ? cleaned.replace(/[OoQDlI|!SsBZzg]/g, (ch) => DIGIT_CONFUSIONS[ch] ?? ch)
        : cleaned;
      return repaired.toUpperCase();
    }
  }

  return null;
};

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/** Repair digit confusions inside a date fragment (never inside a month NAME). */
const repairDateDigits = (fragment) => String(fragment)
  .replace(/[OoQDlI|!SsBZzgqAT]/g, (ch) => DIGIT_CONFUSIONS[ch] ?? ch);

/**
 * Is `day` a real day of `month` (1-12) in `year`?
 *
 * THE "Feb 30" DEFECT: the day was range-checked as 1..31 with no reference to
 * the month, so "Feb 30, 2026" produced the string "2026-02-30". JavaScript's
 * Date then silently ROLLS IT OVER to March 2 — and because the rolled date was
 * ~12h from `now`, the ±24h tolerance check PASSED. A receipt with a garbled
 * month could therefore clear the date gate with a date that does not exist.
 *
 * Month lengths are computed via Date rather than a table so leap years are
 * handled for free (Feb 29 is valid in 2028, invalid in 2026).
 */
const isValidCalendarDate = (year, month, day) => {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1) return false;
  // Day 0 of the NEXT month is the last day of THIS month.
  const daysInMonth = new Date(y, m, 0).getDate();
  return d <= daysInMonth;
};

/**
 * Extract a date as an ISO `YYYY-MM-DD` string, or null.
 *
 * Handles "Jan 15, 2025", "15 Jan 2025", "01/15/2025", "2025-01-15".
 *
 * WHY EVERY CANDIDATE IS ITERATED (the "Ref 9988" defect): `String.match`
 * returns only the FIRST hit, and the day-first pattern happily matched the junk
 * "00\nRef 9988" — "00" from the amount "2500", a newline, then "Ref" as the
 * "month" and "9988" as the year. Because `MONTHS['ref']` is undefined the whole
 * extraction returned null, DISCARDING the genuine "15 Jan 2025" further down
 * and failing the date gate. So we scan all candidates and take the first whose
 * month name is real.
 */
const extractDate = (text) => {
  if (!text) return null;
  const source = String(text);

  const iso = repairDateDigits(source).match(/(20\d{2})-([0-9]{1,2})-([0-9]{1,2})/);
  if (iso) {
    // Validate before returning: an impossible ISO date must not be emitted.
    if (isValidCalendarDate(iso[1], iso[2], iso[3])) {
      return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
    }
  }

  const monthFirst = /([A-Za-z]{3,9})\.?\s+([0-9OoQDlI|!SsBZzgqT]{1,2})(?:st|nd|rd|th)?,?\s+([0-9OoQDlI|!SsBZzgqT]{4})/g;
  for (const m of source.matchAll(monthFirst)) {
    const monthIndex = MONTHS[m[1].toLowerCase()];
    if (monthIndex === undefined) continue;
    const day = repairDateDigits(m[2]);
    const year = repairDateDigits(m[3]);
    if (isValidCalendarDate(year, monthIndex + 1, day)) {
      return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const dayFirst = /([0-9OoQDlI|!SsBZzgqT]{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+([0-9OoQDlI|!SsBZzgqT]{4})/g;
  for (const m of source.matchAll(dayFirst)) {
    const monthIndex = MONTHS[m[2].toLowerCase()];
    if (monthIndex === undefined) continue;
    const day = repairDateDigits(m[1]);
    const year = repairDateDigits(m[3]);
    if (isValidCalendarDate(year, monthIndex + 1, day)) {
      return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const numeric = repairDateDigits(source).match(/(\d{1,2})[/-](\d{1,2})[/-](20\d{2})/);
  if (numeric) {
    const [, a, b, y] = numeric.map(Number);
    // If the first field cannot be a month, the pair is DD/MM.
    const month = a > 12 ? b : a;
    const day = a > 12 ? a : b;
    if (isValidCalendarDate(y, month, day)) {
      return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return null;
};

/**
 * Recipient labels that are unambiguous on their own.
 *
 * A bare "to" is deliberately NOT in this list — see BARE_TO_LABEL below for the
 * defect that caused.
 */
const RECIPIENT_LABELS = /(sent\s*to|send\s*money\s*to|paid\s*to|receiver|recipient|transferred\s*to)\s*[:\-]?\s*(.*)/i;

/**
 * A standalone "To" is a recipient label; the "to" inside "Total" is not.
 *
 * THE "tal Amount Sent" DEFECT: with `to` in the alternation above, the label
 * regex matched the `to` INSIDE the word "Total". The amount label line
 * ("Total Amount Sent") was therefore parsed as the payee and the capture came
 * out as "tal Amount Sent". The fail-fast name gate compares the payee against
 * the shop's registered name and aborts on mismatch, so this REJECTED a
 * completely valid payment with NAME_MISMATCH.
 */
const BARE_TO_LABEL = /(?:^|\s)to\s*[:\-]?\s*(.+)/i;

/**
 * Extract the payee name.
 *
 * GCash and Maya print the label and the payee on SEPARATE lines:
 *
 *     Sent to
 *     COMAR GARAGE
 *
 * so when the labelled line has nothing after it, the NEXT non-empty line is
 * read. Missing this split produced a garbage payee and, through the name gate,
 * a rejected receipt.
 */
const extractRecipient = (text) => {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/);

  const clean = (value) => String(value || '')
    .replace(/[^\p{L}\p{N}\s.,'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // NOTE THE GROUP INDEX. RECIPIENT_LABELS captures the LABEL first and the
    // NAME second, so the name is group 2. BARE_TO_LABEL has no label group, so
    // its name is group 1. Reading group 1 for both captured the literal string
    // "Sent to" as the payee, which failed the name gate and rejected a valid
    // payment.
    const labelled = line.match(RECIPIENT_LABELS);
    const bare = labelled ? null : line.match(BARE_TO_LABEL);
    if (!labelled && !bare) continue;

    const sameLineName = labelled ? labelled[2] : bare[1];

    let name = clean(sameLineName);

    if (name.length < 3) {
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j += 1) {
        const candidate = clean(lines[j]);
        if (candidate.length >= 3) { name = candidate; break; }
      }
    }

    if (
      name.length >= 3
      && !/^[\d\s.,]+$/.test(name)
      && !/amount|total|fee/i.test(name)
      && !/^(sent|send|paid|transferred)\b/i.test(name)
    ) {
      return name;
    }
  }

  return null;
};

/**
 * Does this text look like a payment receipt at all? Requires SOME money signal
 * AND SOME anchor word, so a random photo's text is not mistaken for a receipt.
 */
const looksLikeReceipt = (text) => {
  if (!text) return false;
  const hasMoney = /[₱Pp]\s*\d|\d+[.,]\d{2}|\btotal\b|\bamount\b/i.test(text);
  const hasAnchor = /\b(reference|ref|trace|transaction|date|gcash|maya|instapay|pesonet)\b/i.test(text);
  return hasMoney && hasAnchor;
};

/**
 * Parse raw OCR text into the structured shape the verification pipeline uses.
 *
 * MONEY MODEL (unchanged from the Gemini era — the business rule is the same):
 * e-wallet receipts print a GROSS the customer sent plus a separate fee line; the
 * shop receives the NET. Both are returned; the CALLER enforces net = gross − fee
 * rather than trusting any single figure.
 *
 * @param {string} rawText
 * @returns {{
 *   amount:number|null, grossAmount:number|null, transferFee:number,
 *   referenceNumber:string|null, timestamp:string|null, recipient:string|null,
 *   isValidReceipt:boolean, rawText:string
 * }}
 */
const parseReceiptText = (rawText) => {
  const text = String(rawText || '');
  const amounts = extractAmounts(text);

  const fee = amounts.fee !== null && amounts.fee > 0 ? amounts.fee : 0;
  const gross = amounts.gross ?? amounts.net ?? amounts.generic ?? null;
  const net = gross !== null ? Math.max(0, Math.round((gross - fee) * 100) / 100) : null;

  return {
    amount: net,
    grossAmount: gross,
    transferFee: fee,
    referenceNumber: extractReferenceNumber(text),
    timestamp: extractDate(text),
    recipient: extractRecipient(text),
    isValidReceipt: looksLikeReceipt(text),
    rawText: text,
  };
};

module.exports = {
  parseReceiptText,
  parseAmountToken,
  extractAmounts,
  extractReferenceNumber,
  extractDate,
  extractRecipient,
  looksLikeReceipt,
};