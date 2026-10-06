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

const normalizeAmountValue = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value);
  if (!/\d/.test(raw) && !/[₱PpFf£¥$]|\bPHP\b/i.test(raw)) return null;
  const parsed = parseAmountToken(value);
  return parsed !== null && Number.isFinite(parsed) ? parsed : null;
};

/** Labels for the amount actually paid/received, most specific first. */
const AMOUNT_LABELS = [
  { key: 'net', pattern: /(total\s*amount\s*(received|sent)|total\s*amount(?!\s*paid)|amount\s*received|net\s*amount|received\s*amount)/i },
  { key: 'gross', pattern: /(total\s*amount\s*paid|total\s*paid|amount\s*paid|paid\s*amount|total\s*sent|grand\s*total|\bpaid\b|\bamount\b)/i },
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
const CURRENCY_WORD = /^(?:[₱£¥$]|PHP|Php|php|P|p|F|f)$/;
const MONEY_WORD = /^([₱£¥$]|PHP|Php|php|P|p|F|f)?([0-9OoQDlI|!SsBZzgqAT]+(?:[.,][0-9OoQDlI|!SsBZzgqAT]{1,3})*)$/;
const MONTH_NAMES = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b\\.?';

/**
 * A line with its dates and times taken out. "Oct 26, 2023, 03:45 PM" must never leak a "45" or a "2023"
 * into the money candidates (this was the "OCR reads 45 pesos" defect: the figure sat ABOVE its label, so the
 * parser looked at the next line, the date and time, and took the minutes).
 */
const stripDatesAndTimes = (line) => String(line)
  .replace(/\b\d{1,2}\s*[:.]\s*\d{2}(?:\s*:\s*\d{2})?\s*(?:[AaPp]\.?\s?[Mm]\.?)?(?![\d,])/g, (match) => (/[:]/.test(match) || /[AaPp]\.?\s?[Mm]/.test(match) ? ' ' : match))
  .replace(new RegExp('\\b' + MONTH_NAMES + '\\s*\\d{1,2}\\s*,?\\s*(?:\\d{2,4})?', 'gi'), ' ')
  .replace(new RegExp('\\b\\d{1,2}\\s*' + MONTH_NAMES + '\\s*,?\\s*(?:\\d{2,4})?', 'gi'), ' ')
  .replace(/\b\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4}\b/g, ' ');

const repairDigits = (text) => String(text).replace(/[OoQDlI|!SsBZzgqAT]/g, (ch) => DIGIT_CONFUSIONS[ch] ?? ch);

/**
 * Money-shaped tokens on one line, each with how strongly it looks like an amount.
 * A token is rejected when it is really something else: a reference or phone number (8 or more digits with no
 * separator), a word ("To", "Total"), or a date/time fragment (removed first).
 */
const moneyTokensOnLine = (line) => {
  const words = stripDatesAndTimes(line).split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    let word = words[i];
    let glyph = false;
    if (CURRENCY_WORD.test(word) && i + 1 < words.length) { glyph = true; i += 1; word = words[i]; }
    const match = word.match(MONEY_WORD);
    if (!match) continue;
    if (match[1] && /[₱£¥$]|^(?:PHP|Php|php)$/.test(match[1])) glyph = true;
    else if (match[1] && /^[PpFf]$/.test(match[1]) && /\d/.test(match[2])) glyph = true;
    const body = match[2];
    const realDigits = (body.match(/\d/g) || []).length;
    const digits = repairDigits(body).replace(/[^0-9]/g, '').length;
    if (digits < 1) continue;
    if (!glyph && realDigits === 0) continue;
    if (realDigits && realDigits / Math.max(1, body.replace(/[.,]/g, '').length) < 0.5) continue;
    const hasSeparator = /[.,]/.test(body);
    if (!hasSeparator && digits >= 8) continue; // a reference or phone number, not money
    if (hasSeparator && digits >= 14) continue;
    const value = parseAmountToken((glyph && !/[₱£¥$]/.test(word) ? '₱' : '') + body);
    if (value === null || !(value > 0)) continue;
    const decimals = /[.,]\d{2}$/.test(body);
    out.push({ value, glyph, decimals, separator: hasSeparator, strong: glyph || decimals || /\d,\d{3}/.test(body), score: (glyph ? 3 : 0) + (decimals ? 3 : 0) + (hasSeparator ? 1 : 0) });
  }
  return out;
};

const bestToken = (tokens, strongOnly) => {
  const pool = strongOnly ? tokens.filter((t) => t.strong) : tokens;
  if (!pool.length) return null;
  return pool.reduce((best, t) => (t.score >= best.score ? t : best), pool[0]);
};

/**
 * Extract amount candidates from raw OCR text.
 *
 * Receipts put the figure either on the label's line, on the line AFTER it ("Total Amount Sent" / "2,500.00"), or
 * on the line BEFORE it (a big "₱2,500.00" with "Amount Paid" printed underneath). So the nearest strong money
 * token within two lines either way is used, never a token from a line that carries a different label, and never
 * a date, time, reference or phone number. With no label at all, the most amount-like token on the receipt
 * (currency sign and two decimals) is taken as the amount.
 */
const extractAmounts = (text) => {
  const found = { net: null, gross: null, fee: null, generic: null };
  if (!text) return found;

  const lines = String(text).split(/\r?\n/);
  const tokens = lines.map(moneyTokensOnLine);
  const labels = lines.map((line) => {
    if (!line.trim()) return null;
    const source = repairLabelText(line);
    for (const candidate of AMOUNT_LABELS) {
      if (candidate.pattern.test(source)) return candidate.key;
    }
    return null;
  });

  const valueFor = (i) => {
    // 1. the label line itself
    const own = bestToken(tokens[i], true);
    if (own) return own.value;
    // 2. the nearest strong token within two lines, after the label first, then before it
    for (let d = 1; d <= 2; d += 1) {
      for (const j of [i + d, i - d]) {
        if (j < 0 || j >= lines.length || !lines[j].trim()) continue;
        if (labels[j]) continue; // that figure belongs to another label
        const near = bestToken(tokens[j], true);
        if (near) return near.value;
      }
    }
    // 3. a plain number alone on the next line ("Amount" / "2500")
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j += 1) {
      if (!lines[j].trim() || labels[j]) continue;
      const bare = bestToken(tokens[j], false);
      if (bare && tokens[j].length === 1) return bare.value;
      break;
    }
    return null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const label = labels[i];
    if (!label || found[label] !== null) continue;
    const value = valueFor(i);
    if (value !== null) found[label] = value;
  }

  if (found.net === null && found.gross === null && found.generic === null) {
    // No usable label (low-contrast labels are often dropped by the reader): the most amount-like figure wins.
    const all = tokens.flatMap((list, index) => list.map((t) => ({ ...t, index })));
    const hero = all.filter((t) => t.strong).sort((a, b) => b.score - a.score || a.index - b.index)[0];
    if (hero) found.generic = hero.value;
  }

  return found;
};

const REFERENCE_LABEL = /(reference\s*(?:no|number|id|#)?|ref\s*(?:no|number|id|#)?|trace\s*(?:no|number)?|transaction\s*(?:id|no|number)|transac(?:tion)?\s*id)/i;

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
 *   • at least 70% of the characters are already digits, AND
 *   • there is no run of 2+ consecutive letters.
 * Real alphanumeric references carry letter PREFIXES; OCR noise interleaves
 * single letters among digits ("9O2L33488722L").
 */
const cleanReference = (token) => {
  const cleaned = String(token || '').replace(/\s+/g, '').replace(/^[-]+|[-]+$/g, '').trim();
  if (cleaned.length < 6 || !/\d/.test(cleaned)) return null;
  const chars = cleaned.replace(/[^A-Za-z0-9]/g, '');
  const digitRatio = chars.length ? (chars.match(/\d/g) || []).length / chars.length : 0;
  const hasLetterRun = /[A-Za-z]{2,}/.test(cleaned);
  const repaired = digitRatio >= 0.7 && !hasLetterRun
    ? cleaned.replace(/[OoQDlI|!SsBZzg]/g, (ch) => DIGIT_CONFUSIONS[ch] ?? ch)
    : cleaned;
  return repaired.toUpperCase();
};

// Words that sit next to a reference label but are not the reference.
const NOT_A_REFERENCE_WORD = /^(?:no|number|id|date|time|oct|nov|dec|jan|feb|mar|apr|may|jun|jul|aug|sep)$/i;

const extractReferenceNumber = (text) => {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/);

  // 1. by label: the token after "Reference No" on the same line, or on the next lines
  for (let i = 0; i < lines.length; i += 1) {
    const labelMatch = lines[i].match(REFERENCE_LABEL);
    if (!labelMatch) continue;
    const sources = [lines[i].slice(labelMatch.index + labelMatch[0].length), lines[i + 1], lines[i + 2]];
    for (const source of sources) {
      if (!source || !String(source).trim()) continue;
      const candidate = stripDatesAndTimes(source).match(/([A-Za-z0-9][A-Za-z0-9\s-]{4,})/);
      if (!candidate) continue;
      const ref = cleanReference(candidate[1]);
      if (ref && !NOT_A_REFERENCE_WORD.test(ref)) return ref;
    }
  }

  // 2. the label was not read (small grey labels often are): a standalone mixed or long reference-looking token
  for (const line of lines) {
    const words = stripDatesAndTimes(line).split(/\s+/).filter(Boolean);
    for (const word of words) {
      const w = word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
      if (w.length < 10 || w.length > 24 || !/^[A-Za-z0-9]+$/.test(w)) continue;
      const digitCount = (w.match(/\d/g) || []).length;
      if (digitCount < 6) continue;
      if (/^0?9\d{9,10}$/.test(w) || /^\+?639\d{9}$/.test(w)) continue; // a mobile number
      if (/^\d{1,3}(?:[,.]\d{3})+(?:[.,]\d{2})?$/.test(w)) continue;
      const ref = cleanReference(w);
      if (ref) return ref;
    }
  }

  return null;
};

/**
 * Recipient labels that are unambiguous on their own.
 *
 * A bare "to" is deliberately NOT in this list — see BARE_TO_LABEL below.
 */
const RECIPIENT_LABELS = /(sent\s*to|send\s*money\s*to|paid\s*to|receiver(?:\s*name)?|recipient(?:\s*name)?|transferred\s*to|beneficiary(?:\s*name)?|account\s*name)\s*[:\-]?\s*(.*)/i;

/**
 * A standalone "To" is a recipient label; the "to" inside "Total" is not.
 */
const BARE_TO_LABEL = /(?:^|\s)to\s*[:\-]?\s*(.+)/i;

// Words that are field labels or headings, never a person's or a shop's name.
const LABEL_WORD = /^(?:name|details?|account|acct|number|no|info|information|mobile|phone|gcash|wallet|maya|bank|type|source|purpose|remarks?|reference|amount|date|time|transaction|send|sent|money|payment|successful|personal|to|from)$/i;
const isLabelLine = (line) => /^(?:recipient|receiver|beneficiary|account|mobile|number|name|details?|purpose|reference|ref|amount|date|transaction|source|remarks?|mode|total|fee)\b/i.test(String(line).trim());

const cleanName = (value) => String(value || '')
  .replace(/[^\p{L}\p{N}\s.,'-]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const looksLikeName = (name) => {
  if (name.length < 3) return false;
  if (/^[\d\s.,]+$/.test(name)) return false;
  if (/amount|total|fee/i.test(name)) return false;
  if (/^(sent|send|paid|transferred)\b/i.test(name)) return false;
  const words = name.split(' ').filter(Boolean);
  return !words.every((word) => LABEL_WORD.test(word));
};

/**
 * Extract the payee name, allowing the label and name to appear on separate lines ("Recipient Name" on one line,
 * "Bunny Monera" on the next), skipping headings such as "Recipient Details" and other labels in between.
 * When the label was not read at all, a name-shaped line directly above a mobile or account number is used.
 */
const extractRecipient = (text) => {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const labelled = line.match(RECIPIENT_LABELS);
    const bare = labelled ? null : line.match(BARE_TO_LABEL);
    if (!labelled && !bare) continue;
    let name = cleanName(labelled ? labelled[2] : bare[1]);

    if (!looksLikeName(name)) {
      name = '';
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
        if (isLabelLine(lines[j])) continue;
        const candidate = cleanName(lines[j]);
        if (looksLikeName(candidate)) { name = candidate; break; }
      }
    }
    if (name && looksLikeName(name)) return name;
  }

  // No label: a name-shaped line right above a mobile/account number line
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const candidate = cleanName(lines[i]);
    const next = String(lines[i + 1] || '');
    const nextDigits = next.replace(/[^0-9]/g, '');
    if (nextDigits.length >= 10 && /^[\d\s+()-]+$/.test(next.trim()) && /^[\p{L}][\p{L}.'-]*(?:\s+[\p{L}][\p{L}.'-]*){1,4}$/u.test(candidate) && looksLikeName(candidate)) {
      return candidate;
    }
  }

  return null;
};

/**
 * Does this text look like a payment receipt at all? Requires SOME money signal
 * AND SOME non-date receipt anchor.
 */
const looksLikeReceipt = (text) => {
  if (!text) return false;
  const hasMoney = /[₱Pp]\s*\d|\d+[.,]\d{2}|\btotal\b|\bamount\b/i.test(text);
  const hasAnchor = /\b(reference|ref|trace|transaction|gcash|maya|instapay|pesonet)\b/i.test(text);
  return hasMoney && hasAnchor;
};

const isValidReferenceNumber = (value) => {
  const reference = String(value || '').trim();
  if (!/^[A-Z0-9](?:[A-Z0-9]|[ -](?=[A-Z0-9]))*[A-Z0-9]$/i.test(reference)) return false;
  return /^[A-Z0-9]{6,40}$/i.test(reference.replace(/[ -]/g, ''));
};

/**
 * Parse raw OCR text into the structured shape the verification pipeline uses.
 *
 * MONEY MODEL: e-wallet receipts print a GROSS the customer sent plus a separate
 * fee line; the caller enforces net = gross - fee rather than trusting a figure.
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
  let gross = amounts.gross ?? amounts.net ?? amounts.generic ?? null;
  // "Amount 500 + Transfer fee 5 = Total Amount Sent 505": the customer sent the total, and the shop
  // receives the amount without the fee. Without this the plain "Amount" line was taken as the gross
  // and the fee was subtracted a second time (net 495).
  if (fee > 0 && amounts.net !== null && amounts.gross !== null && Math.abs(amounts.gross + fee - amounts.net) < 0.015) {
    gross = amounts.net;
  } else if (fee > 0 && amounts.generic !== null && amounts.gross !== null && Math.abs(amounts.gross + fee - amounts.generic) < 0.015) {
    // the same, with a plain "Total" line
    gross = amounts.generic;
  }
  const net = gross !== null ? Math.max(0, Math.round((gross - fee) * 100) / 100) : null;

  return {
    amount: net,
    grossAmount: gross,
    transferFee: fee,
    referenceNumber: extractReferenceNumber(text),
    timestamp: null,
    recipient: extractRecipient(text),
    isValidReceipt: looksLikeReceipt(text),
    rawText: text,
  };
};

module.exports = {
  parseReceiptText,
  isValidReferenceNumber,
  parseAmountToken,
  normalizeAmountValue,
  extractAmounts,
  extractReferenceNumber,
  extractRecipient,
  looksLikeReceipt,
};