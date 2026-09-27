/**
 * receiptOcr.js
 * ============================================================================
 * CLIENT-SIDE receipt text extraction with Tesseract.js.
 *
 * WHY THIS REPLACED GEMINI
 * ------------------------
 * The Gemini path was accurate but slow: model discovery (up to 8 s) plus LLM
 * inference, with a 12 s per-model timeout cascading across every discovered
 * model. Customers sat on a spinner. Tesseract runs locally in the browser, so
 * extraction starts instantly and costs nothing per scan.
 *
 * THE TRUST BOUNDARY — READ THIS BEFORE CHANGING ANYTHING
 * ------------------------------------------------------
 * This module produces a HINT, not a verdict. Everything it returns is
 * attacker-controlled: a user can open DevTools and call it with hand-written
 * text, or simply edit the request. The server therefore treats this payload as
 * untrusted input and:
 *
 *   • still receives the RAW IMAGE (so SC-17's byte-hash duplicate gate works)
 *   • still re-parses the text itself and owns the final verdict
 *
 * If the image upload is ever removed, the duplicate-image control disappears
 * and this becomes a self-certification hole. See backend/server.js
 * /api/ocr/verify-receipt.
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
  { key: 'gross', pattern: /(total\s*amount\s*paid|total\s*paid|amount\s*paid|total\s*sent|grand\s*total)/i },
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
        return /[₱PpFf£¥$]/.test(token) || /[.,]/.test(token);
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
    if (!label || found[label] !== null) continue;

    // Same line first ("Total: ₱2,500.00") but ONLY when the figure is clearly
    // money-marked, then the next non-empty line ("Total Amount Sent" /
    // "₱2,500.00"), which is how GCash and Maya actually lay it out.
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
    const tokenMatch = after.match(/([A-Za-z0-9][A-Za-z0-9\s-]{4,})/);
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

/** Month-name lookup, including the abbreviations OCR usually preserves. */
const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/**
 * Repair digit confusions inside a DATE fragment.
 *
 * Tesseract mangles dates the same way it mangles money: "Jan l5, 2O25" (lower
 * L, capital O) and "15-O1-2O25" are common. Without this the date extractor
 * returns null, the server's date gate fails, and a legitimate receipt is
 * rejected. Applied only to the numeric/date candidates, never to the month
 * NAME, so "May" is not rewritten into "4ay".
 */
const repairDateDigits = (fragment) => String(fragment)
  .replace(/[OoQDlI|!SsBZzgqAT]/g, (ch) => DIGIT_CONFUSIONS[ch] ?? ch);

/**
 * Is `day` a real day of `month` (1-12) in `year`?
 *
 * THE "Feb 30" DEFECT: the day was range-checked as 1..31 with no reference to
 * the month, so "Feb 30, 2026" produced "2026-02-30". JavaScript's Date then
 * silently ROLLS IT OVER to March 2, and because the rolled date was ~12h from
 * `now`, the ±24h tolerance check PASSED — a receipt with a garbled month could
 * clear the date gate with a date that does not exist.
 *
 * Month lengths are computed via Date so leap years work for free (Feb 29 valid
 * in 2028, invalid in 2026).
 */
const isValidCalendarDate = (year, month, day) => {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(y, m, 0).getDate();
  return d <= daysInMonth;
};

/**
 * Date extraction. Handles the shapes GCash/Maya actually print:
 *   "Jan 15, 2025"   "January 15, 2025"   "15 Jan 2025"
 *   "01/15/2025"     "2025-01-15"          "15-01-2025"
 *
 * Returns an ISO `YYYY-MM-DD` string, or null. The SERVER re-validates the
 * resulting date against its tolerance window, so a wrong guess here is caught
 * rather than trusted.
 *
 * WHY THIS ITERATES EVERY CANDIDATE (the "Ref 9988" defect)
 * ---------------------------------------------------------
 * `String.match` returns only the FIRST match, and the day-first pattern happily
 * matched the junk `"00\nRef 9988"` — "00" from the amount "2500", a newline,
 * then "Ref" as the "month" and "9988" as the year. Because `MONTHS['ref']` is
 * undefined the whole extraction then returned null, DISCARDING the genuine
 * "15 Jan 2025" further down the page and failing the server's date gate.
 *
 * So we enumerate every candidate and accept the first whose month name is
 * actually a month. A false candidate is skipped, not fatal.
 */
export const extractDate = (text) => {
  if (!text) return null;
  const source = String(text);

  // 1. ISO: 2025-01-15 (repair first, so "2O25-O1-15" is recoverable).
  const iso = repairDateDigits(source).match(/(20\d{2})-([0-9]{1,2})-([0-9]{1,2})/);
  if (iso && isValidCalendarDate(iso[1], iso[2], iso[3])) {
    return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  }

  // 2. Month-name forms, either order. The month NAME is matched against the
  //    RAW text (so "May" stays "May"), while the day/year are repaired.
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

  // 3. Slash / dash numeric forms.
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
 * out as "tal Amount Sent". The server compares the payee against the shop's
 * registered name and aborts on mismatch (the fail-fast name gate), so this
 * REJECTED a completely valid payment with NAME_MISMATCH.
 *
 * The word boundary on both sides lets a standalone "To" match while "Total"
 * does not.
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

/**
 * Does this text look like a payment receipt at all? Used only as a hint; the
 * server decides. A receipt must show SOME money signal and SOME reference or
 * date, otherwise the upload is probably a random photo.
 */
export const looksLikeReceipt = (text) => {
  if (!text) return false;
  const hasMoney = /[₱Pp]\s*\d|\d+[.,]\d{2}|\btotal\b|\bamount\b/i.test(text);
  const hasAnchor = /\b(reference|ref|trace|transaction|date|gcash|maya|instapay|pesonet)\b/i.test(text);
  return hasMoney && hasAnchor;
};

/**
 * Parse raw OCR text into the structured shape the backend expects.
 *
 * MONEY MODEL — gross vs net (carried over from the Gemini pipeline, because the
 * business rule did not change): e-wallet receipts print a GROSS the customer
 * sent plus a separate fee line; the shop receives the NET. We return both and
 * let the SERVER enforce net = gross − fee rather than trusting this arithmetic.
 *
 * @param {string} rawText
 * @returns {{
 *   amount: number|null, grossAmount: number|null, transferFee: number,
 *   referenceNumber: string|null, timestamp: string|null, recipient: string|null,
 *   isValidReceipt: boolean, rawText: string
 * }}
 */
export const parseReceiptText = (rawText) => {
  const text = String(rawText || '');
  const amounts = extractAmounts(text);

  const fee = amounts.fee !== null && amounts.fee > 0 ? amounts.fee : 0;

  // Gross is the "total paid" figure when present; otherwise the net label.
  const gross = amounts.gross ?? amounts.net ?? amounts.generic ?? null;

  // Net = gross − fee when a fee line exists, else the same figure.
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

/**
 * How long the OCR engine may take before we give up and fall back to manual
 * review. Generous enough for a slow mobile connection to fetch the worker/WASM
 * (~10 MB on first use, then cached), but bounded so a blocked download cannot
 * spin forever.
 */
const OCR_INIT_TIMEOUT_MS = 45000;
const OCR_RECOGNIZE_TIMEOUT_MS = 45000;

/**
 * Reject if `promise` does not settle within `ms`.
 *
 * WHY THIS EXISTS: Tesseract fetches its worker script and WASM core from a CDN
 * at runtime. On a strict ad-blocker, a corporate proxy, an offline device, or a
 * captive-portal network that request can hang WITHOUT rejecting — the fetch
 * simply never settles. Without a bound, `await createWorker(...)` never returns,
 * `isUploading` stays true forever, and the customer watches a spinner with no
 * way forward. A timeout converts that silent hang into a catchable error, which
 * the caller turns into the manual-review path.
 */
const withTimeout = (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Run Tesseract over a File/Blob and return structured receipt fields.
 *
 * RESILIENCE — every failure mode degrades rather than hangs:
 *   • the lazy `import()` rejects (chunk blocked/offline)      -> throws, caught by caller
 *   • the worker/WASM download stalls (ad-blocker, proxy)      -> OCR_INIT_TIMEOUT_MS
 *   • recognition stalls on a pathological image               -> OCR_RECOGNIZE_TIMEOUT_MS
 *   • the worker is created but a later step throws            -> terminated in `finally`
 *
 * The worker is created per call and terminated in `finally`. A long-lived worker
 * leaks memory across scans, and receipt uploads are infrequent enough that
 * re-initialisation cost is irrelevant next to correctness. Note the `finally`
 * covers `createWorker` itself: an earlier draft created the worker OUTSIDE the
 * try block, so a failure in `setParameters` leaked a live worker (and its
 * WASM heap) on every retry.
 *
 * `onProgress` receives a 0..1 fraction so the UI can show real progress
 * instead of an indeterminate spinner.
 *
 * @param {File|Blob} file
 * @param {(fraction:number, status:string) => void} [onProgress]
 */
export const extractReceiptFromImage = async (file, onProgress) => {
  // Imported lazily so tesseract.js (and its worker/wasm assets) is only fetched
  // when a customer actually uploads a receipt, never on first paint. This import
  // itself can fail (chunk blocked, offline) and is intentionally NOT wrapped —
  // the caller catches it and routes to manual review.
  const { createWorker } = await import('tesseract.js');

  let worker = null;
  try {
    worker = await withTimeout(
      createWorker('eng', 1, {
        logger: (m) => {
          if (typeof onProgress === 'function' && m && m.status) {
            onProgress(Number(m.progress) || 0, m.status);
          }
        },
      }),
      OCR_INIT_TIMEOUT_MS,
      'OCR engine initialisation'
    );

    // PSM 6 = "assume a single uniform block of text", which matches the
    // narrow, dense column layout of a wallet receipt far better than the
    // default page-segmentation mode.
    await withTimeout(worker.setParameters({ tessedit_pageseg_mode: '6' }), OCR_INIT_TIMEOUT_MS, 'OCR configuration');

    const { data } = await withTimeout(worker.recognize(file), OCR_RECOGNIZE_TIMEOUT_MS, 'OCR recognition');
    return parseReceiptText(data?.text || '');
  } finally {
    // Best-effort teardown. `terminate()` itself can reject if the worker never
    // finished booting, and an unhandled rejection here would surface as a
    // console error even though the user already got a valid fallback.
    if (worker) {
      try {
        await worker.terminate();
      } catch (terminateErr) {
        console.warn('[OCR] worker.terminate() failed (non-fatal):', terminateErr?.message || terminateErr);
      }
    }
  }
};

export default {
  extractReceiptFromImage,
  parseReceiptText,
  parseAmountToken,
  extractAmounts,
  extractReferenceNumber,
  extractDate,
  extractRecipient,
  looksLikeReceipt,
};