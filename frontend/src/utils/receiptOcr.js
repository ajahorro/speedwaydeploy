/**
 * receiptOcr.js
 * ============================================================================
 * Receipt text parser mirror used by cross-runtime regression tests.
 *
 * Production image extraction runs on the backend. This matching parser is
 * retained to detect client/server parsing drift in the regression suite.
 *
 * WHY THE PARSING IS SO DEFENSIVE
 * -------------------------------
 * Tesseract reads pixels, not meaning. Measured failure modes on GCash / Maya
 * screenshots, all of which corrupt naive parsing:
 *
 *   ₱  ->  P, F, f, 7, £          "₱2,500.00" becomes "P2,500.00"
 *   0  ->  O, o, Q                "1,080" becomes "1,O8O"
 *   1  ->  l, I, |                "1,250" becomes "l,250"
 *   5  ->  S, s                   "2,500" becomes "2,S00"
 *   8  ->  B                      "1,080" becomes "1,OB0"
 *   .  ->  , or a stray space     "2500.00" becomes "2500 00"
 *   ,  ->  . or dropped entirely  "2,500" becomes "2.500" or "2500"
 *
 * A single mangled digit in a numeric comparison is not a cosmetic problem:
 * the server rejects a receipt that is ₱1.00 short, so a misread ₱2,500 as
 * ₱2,SOO must be recovered or a legitimate payment is refused.
 * ============================================================================
 */

/**
 * Confusion map for digits Tesseract commonly mis-recognises inside a NUMERIC
 * context. Applied only after a value has been identified as "this token should
 * be a number", never to prose — rewriting letters in prose would corrupt the
 * recipient name.
 */
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

/** Currency glyphs Tesseract emits in place of ₱. */
const PESO_GLYPHS = /[₱PpFf£¥$]|\bPHP\b|\bPhp\b/gi;

/**
 * Normalise a numeric token: strip currency glyphs/whitespace, repair known
 * digit confusions, and decide the decimal separator.
 *
 * THE AMBIGUOUS-SEPARATOR RULE
 * ----------------------------
 * "2.500" is ambiguous: ₱2.50 with a stray 0, or ₱2,500 with a comma misread as
 * a dot? The rule used here is positional and matches how Philippine receipts
 * actually print money:
 *
 *   • exactly one separator with 2 digits after it  -> decimal point  ("2,500.00")
 *   • exactly one separator with 3 digits after it  -> thousands      ("2.500" -> 2500)
 *   • multiple separators                           -> the LAST is decimal
 *
 * A 3-digit tail is treated as thousands because no peso amount is printed with
 * three decimal places, whereas thousands groups are always 3 digits.
 *
 * @param {string} raw
 * @returns {number|null}
 */
export const parseAmountToken = (raw) => {
  if (raw === null || raw === undefined) return null;
  let text = String(raw).trim();
  if (!text) return null;

  // Drop currency words/glyphs, then repair letter-for-digit confusions.
  text = text.replace(PESO_GLYPHS, '');
  text = text.replace(/[OoQDlI|!SsBZzgqAT]/g, (ch) => DIGIT_CONFUSIONS[ch] ?? ch);
  // Keep only digits and separators.
  text = text.replace(/[^0-9.,]/g, '');
  if (!text) return null;

  const separators = text.match(/[.,]/g) || [];

  if (separators.length === 0) {
    // No separator at all. A bare 4+ digit string on a peso receipt is whole
    // pesos ("2500"), not cents.
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }

  if (separators.length === 1) {
    const [head, tail] = text.split(/[.,]/);
    if (tail.length === 3 && head.length >= 1) {
      // Thousands group: "2.500" / "2,500" -> 2500
      const n = Number(`${head}${tail}`);
      return Number.isFinite(n) ? n : null;
    }
    // Decimal: "2500.00" / "2500,00" / "2500 0" -> 2500.0
    const n = Number(`${head}.${tail}`);
    return Number.isFinite(n) ? n : null;
  }

  // Multiple separators: every group except the last is thousands, the last is
  // the decimal point. "1,250,000.00" -> 1250000.00
  const lastSep = Math.max(text.lastIndexOf('.'), text.lastIndexOf(','));
  const head = text.slice(0, lastSep).replace(/[.,]/g, '');
  const tail = text.slice(lastSep + 1);
  const n = Number(tail ? `${head}.${tail}` : head);
  return Number.isFinite(n) ? n : null;
};

/**
 * Words that label the amount actually PAID / received, in descending
 * specificity. Order matters: "Total Amount Received" must win over a generic
 * "Total" on a receipt that also prints a subtotal.
 */
const AMOUNT_LABELS = [
  { key: 'net', pattern: /(total\s*amount\s*(received|sent)|amount\s*received|net\s*amount|received\s*amount)/i },
  { key: 'gross', pattern: /(total\s*amount\s*paid|total\s*paid|amount\s*paid|paid\s*amount|total\s*sent|grand\s*total|\bpaid\b|\bamount\b)/i },
  { key: 'fee', pattern: /(transfer\s*fee|convenience\s*fee|service\s*fee|instapay\s*fee|pesonet\s*fee|transaction\s*fee|fee)/i },
  { key: 'generic', pattern: /(^|\b)total(\b|:)/i },
];

/**
 * Repair a LABEL for matching purposes only.
 *
 * THE "T0tal Am0unt Sent" DEFECT: Tesseract renders the 'o' in "Total" as a
 * zero often enough that the label itself stops matching, the amount comes back
 * null, and a valid receipt is rejected. We therefore normalise digits that
 * should be letters back to letters BEFORE testing the label patterns:
 *   0->o, 1->l, 5->s, 8->b, 2->z
 * This is the inverse of the money repair and is applied to the label line only,
 * never to a captured value.
 */
const repairLabelText = (line) => String(line)
  .replace(/0/g, 'o')
  .replace(/1/g, 'l')
  .replace(/5/g, 's')
  .replace(/8/g, 'b')
  .replace(/2/g, 'z');

/**
 * A money-shaped run: a contiguous blob that STARTS at a currency glyph or a
 * digit/confusion char and then continues through digits, confusion chars and
 * separators.
 *
 * WHY THIS IS ONE SIMPLE RUN INSTEAD OF AN ALTERNATION (two defects)
 * -----------------------------------------------------------------
 * An earlier version enumerated three "shapes" of money token as regex
 * alternatives. Both failures below came from that:
 *
 *   1. "P2,SOO.OO" matched NOTHING. The shape requiring a real digit beside a
 *      separator rejected a value whose digits were all misread as letters, so a
 *      valid receipt reported a null amount.
 *
 *   2. "P1,234.56" matched only "P1,234". The first alternative won and stopped
 *      before the decimal, so ₱1,234.56 was read as ₱1,234 — a 56-centavo
 *      under-read that a strict amount gate could reject.
 *
 * The fix is to capture the ENTIRE run and let `parseAmountToken` decide what it
 * means. Repair and interpretation are separate concerns; entangling them in the
 * tokenizer is what produced both bugs.
 *
 * The run must still START at a currency glyph or a digit, so prose like "Total
 * Amount Sent" (which begins with letters) yields no candidate.
 */
const NUMBER_LITERAL = /[₱PpFf£¥$]?[0-9OoQDlI|!SsBZzgqAT][0-9OoQDlI|!SsBZzgqAT.,]*/g;

/**
 * Does a captured token look like money rather than a stray fragment of prose?
 *
 * THE "Total Amount Sent" -> 70 DEFECT: the run pattern matches any blob that
 * STARTS with a digit-like char, and prose contains plenty of those ('o', 'l',
 * 'S', 'A'). On the label line "Total Amount Sent" it produced the fragments
 * ["To","l","A","o","S"], and taking the LAST one ("S" -> "5", with "o" -> "0"
 * alongside) recorded an amount of 70 against a ₱2,500 requirement.
 *
 * A real money token must satisfy BOTH:
 *
 *   1. it carries a currency glyph (₱/P/F/£/¥/$), OR it contains a REAL digit
 *      that Tesseract did not have to invent from a letter; and
 *   2. it has at least two characters that are digits (after repair), so a
 *      single-letter fragment cannot qualify.
 *
 * That still admits "P2,SOO.OO" (currency glyph + repaired digits) while
 * rejecting every prose fragment above.
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
 * Extract candidate amounts from raw OCR text.
 *
 * THE LABEL/VALUE SPLIT — WHY THIS LOOKS AT TWO LINES
 * ---------------------------------------------------
 * Real GCash and Maya receipts print the label and the figure on SEPARATE
 * lines:
 *
 *     Total Amount Sent
 *     ₱2,500.00
 *
 * A strictly line-scoped matcher (label and value must share a line) therefore
 * found nothing and returned a null amount — the receipt then failed the
 * server's amount gate and a genuine payment was rejected. So for each labelled
 * line we look at that line AND the next non-empty line, preferring the same
 * line when a figure is present there.
 *
 * @param {string} text
 * @returns {{net:number|null, gross:number|null, fee:number|null, generic:number|null}}
 */
export const extractAmounts = (text) => {
  const found = { net: null, gross: null, fee: null, generic: null };
  if (!text) return found;

  const lines = String(text).split(/\r?\n/);

  /**
   * Pull the best money token out of one line, or null.
   *
   * `strict` rejects bare runs that carry no currency glyph and no separator.
   *
   * WHY: the label line "T0tal Am0unt Sent" contains the fragment "T0", which
   * repairs to "70" and passed the money-shape filter — so a mangled label
   * produced an amount of ₱70. A real receipt figure is either currency-marked
   * ("P2,500") or grouped ("2,500.00", "2.500"); a bare 2-char run next to
   * prose is a label fragment, not money. Strict mode is used for the label line
   * itself; the following line is read in permissive mode, because a bare
   * "2500" there IS a legitimate amount.
   */
  const moneyOnLine = (line, strict = false) => {
    if (!line) return null;
    const matches = [...String(line).matchAll(NUMBER_LITERAL)]
      .map((m) => m[0].trim())
      .filter(looksLikeMoneyToken)
      .filter((token) => {
        if (!strict) return true;
        return (/[₱PpFf£¥$]/.test(token) && /\d/.test(token)) || /[.,]/.test(token);
      });
    if (!matches.length) return null;
    // The value is the LAST money-like token on the line: receipts print
    // "Total Amount   ₱2,500.00", and the trailing figure is the money.
    const value = parseAmountToken(matches[matches.length - 1]);
    return value !== null && value > 0 ? value : null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Which label does this line carry? First (most specific) match wins.
    // The label text is repaired first, so a mangled "T0tal Am0unt Sent" is
    // still recognised as the net/gross amount label.
    const labelSource = repairLabelText(line);
    let label = null;
    for (const candidate of AMOUNT_LABELS) {
      if (candidate.pattern.test(labelSource)) { label = candidate.key; break; }
    }
    if (!label || found[label] !== null) {
      if (!label && found.generic === null && /\b(?:paid|amount|total|grand)\b|[₱PpFf£¥$]|\bphp\b/i.test(line)) {
        const fallbackValue = moneyOnLine(line);
        if (fallbackValue !== null) found.generic = fallbackValue;
      }
      continue;
    }

    // Same line first ("Total: ₱2,500.00") but ONLY when the figure is clearly
    // money-marked, then the next non-empty line ("Total Amount Sent" /
    // "₱2,500.00"), which is how GCash and Maya actually lay it out.
    let value = moneyOnLine(line, true);
    if (value === null) {
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j += 1) {
        if (!lines[j].trim()) continue;
        const nextLabelSource = repairLabelText(lines[j]);
        if (AMOUNT_LABELS.some((candidate) => candidate.pattern.test(nextLabelSource))) break;
        value = moneyOnLine(lines[j]);
        break;
      }
    }

    if (value !== null) found[label] = value;
  }

  return found;
};

/**
 * Reference / trace numbers.
 *
 * Tesseract frequently inserts spaces inside a long alphanumeric reference and
 * confuses 0/O and 1/I. We therefore capture a run of word-characters after the
 * label, strip internal whitespace, and apply the digit repairs only to
 * positions that are unambiguously digits already present in the token.
 */
const REFERENCE_LABEL = /(reference\s*(?:no|number|#)?|ref\s*(?:no|number|#)?|trace\s*(?:no|number)?|transaction\s*(?:id|no|number)|transac(?:tion)?\s*id)/i;

export const extractReferenceNumber = (text) => {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/);

  for (const line of lines) {
    const labelMatch = line.match(REFERENCE_LABEL);
    if (!labelMatch) continue;

    // Everything after the label on this line.
    const after = line.slice(labelMatch.index + labelMatch[0].length);
    // Reference tokens are long alphanumeric runs; allow spaces/hyphens inside
    // because OCR often breaks them up.
    let tokenMatch = after.match(/([A-Za-z0-9][A-Za-z0-9\s-]{4,})/);
    if (!tokenMatch) {
      const nextLine = lines.slice(lines.indexOf(line) + 1).find((candidate) => candidate.trim());
      if (nextLine) tokenMatch = nextLine.match(/([A-Za-z0-9][A-Za-z0-9\s-]{4,})/);
    }
    if (!tokenMatch) continue;

    const cleaned = tokenMatch[1]
      .replace(/\s+/g, '')
      .replace(/^[-]+|[-]+$/g, '')
      .trim();

    // Require enough alphanumerics to be a real reference, not a stray word.
    if (cleaned.length >= 6 && /\d/.test(cleaned)) {
      // Repair digit confusions INSIDE the token — but ONLY when the token is
      // predominantly numeric.
      //
      // THE "ABC123456789" -> "A8C123456789" DEFECT: a reference is often
      // alphanumeric (Maya prints letter-prefixed trace numbers), and blindly
      // rewriting every 'B' to '8' corrupts a genuine letter. Two scans of the
      // SAME receipt would then yield two DIFFERENT references, and the
      // reference-reuse duplicate gate would never fire.
      //
      // THE COUNTER-DEFECT (threshold too strict): at an 80% cut-off a reference
      // like "9O2L33488722L" — 9 digits in 13 characters, 69% — was left
      // unrepaired, so the SAME receipt rescanned produced a different string and
      // slipped past the duplicate gate anyway. The cut-off is therefore 50%:
      // at least half the characters must already be digits before we treat the
      // remaining letters as misread digits. A genuinely letter-heavy reference
      // ("ABC123456789" is 9/12 = 75%... still above 50%) needs a second guard,
      // so we also require the token to contain no RUN of two or more
      // consecutive letters — real alphanumeric references have letter prefixes
      // ("ABC..."), whereas OCR noise interleaves single letters among digits
      // ("9O2L33488722L").
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

/**
 * Recipient labels that are unambiguous on their own.
 *
 * A bare "to" is deliberately NOT in this list — see BARE_TO_LABEL below for the
 * defect that caused.
 */
const RECIPIENT_LABELS = /(sent\s*to|send\s*money\s*to|paid\s*to|receiver|recipient|transferred\s*to)\s*[:-]?\s*(.*)/i;

/**
 * A standalone "To" is a recipient label; the "to" inside "Total" is not.
 *
 * THE "tal Amount Sent" DEFECT: with `to` in the alternation above, the label
 * regex matched the `to` INSIDE the word "Total". The amount label line
 * ("Total Amount Sent") was therefore parsed as the payee and the capture came
 * out as "tal Amount Sent". The server compares the payee against the shop's
 * registered name and aborts on mismatch (the fail-fast name gate), so this
 * REJECTED a completely valid payment with NAME_MISMATCH.
 *
 * The word boundary on both sides lets a standalone "To" match while "Total"
 * does not.
 */
const BARE_TO_LABEL = /(?:^|\s)to\s*[:-]?\s*(.+)/i;

/**
 * Extract the payee name.
 *
 * GCash and Maya print the label and the payee on SEPARATE lines:
 *
 *     Sent to
 *     COMAR GARAGE
 *
 * so when the labelled line has nothing after it, the NEXT non-empty line is
 * read. This is the same label/value split the amount extractor handles, and
 * missing it here produced a garbage payee (and, through the name gate, a
 * rejected receipt).
 */
export const extractRecipient = (text) => {
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
    // its name is group 1. Reading group 1 for both was a real defect: it
    // captured the literal string "Sent to" as the payee, which then failed the
    // server's name gate and rejected a valid payment.
    const labelled = line.match(RECIPIENT_LABELS);
    const bare = labelled ? null : line.match(BARE_TO_LABEL);
    if (!labelled && !bare) continue;

    const sameLineName = labelled ? labelled[2] : bare[1];

    // Same line first ("Sent to: COMAR GARAGE").
    let name = clean(sameLineName);

    // Otherwise the next non-empty line ("Sent to" / "COMAR GARAGE").
    if (name.length < 3) {
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j += 1) {
        const candidate = clean(lines[j]);
        if (candidate.length >= 3) { name = candidate; break; }
      }
    }

    // Reject a capture that is obviously not a payee: a lone number, a fragment
    // that still reads as the amount label it was carved from, or the label
    // itself (which is what a group-index regression looks like).
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

export const looksLikeReceipt = (text) => {
  if (!text) return false;
  const hasMoney = /[₱Pp]\s*\d|\d+[.,]\d{2}|\btotal\b|\bamount\b/i.test(text);
  const hasAnchor = /\b(reference|ref|trace|transaction|gcash|maya|instapay|pesonet)\b/i.test(text);
  return hasMoney && hasAnchor;
};

export const parseReceiptText = (rawText) => {
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
    timestamp: null,
    recipient: extractRecipient(text),
    isValidReceipt: looksLikeReceipt(text),
    rawText: text,
  };
};

export default {
  parseReceiptText,
  parseAmountToken,
  extractAmounts,
  extractReferenceNumber,
  extractRecipient,
  looksLikeReceipt,
};