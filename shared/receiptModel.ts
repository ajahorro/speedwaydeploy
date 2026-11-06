/**
 * shared/receiptModel.ts — the ONE per-transaction receipt model.
 *
 * Used by the browser receipt (frontend/src/components/OfficialReceipt.jsx) and
 * the emailed PDFs (supabase/functions/_shared/officialReceiptPdf.ts). Its rule
 * is the database rule, public.payment_net_received():
 *
 *   net received = admin-verified amount > OCR-detected net > recorded amount
 *   gross paid   = net received + transfer fee (the customer's outlay)
 *
 * When the caller already has a payment_ledger_v row, the SQL-computed
 * net_received / gross_paid are used as-is.
 */
export interface ReceiptPayment {
  id?: string | null
  payment_id?: string | null
  amount?: number | string | null
  detected_amount?: number | string | null
  verified_amount?: number | string | null
  transfer_fee?: number | string | null
  credit_applied?: number | string | null
  /** payment_ledger_v fields (preferred when present). */
  net_received?: number | string | null
  gross_paid?: number | string | null
  status?: string | null
  method?: string | null
  reference_number?: string | null
  detected_ref?: string | null
  reference?: string | null
  created_at?: string | null
  verified_at?: string | null
}

export interface TransactionReceiptAmounts {
  grossPaid: number
  transferFee: number
  netReceived: number
  creditApplied: number
}

const numberValue = (value: unknown): number => {
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : 0
}

export const roundReceiptAmount = (value: number): number =>
  Math.round((numberValue(value) + Number.EPSILON) * 100) / 100

export const getReceiptNumber = (payment: ReceiptPayment): string =>
  `RCP-${String(payment.id || payment.payment_id || 'UNKNOWN').toUpperCase()}`

/** Mirrors public.payment_net_received(amount, detected_amount, verified_amount). */
export const paymentNetReceived = (payment: ReceiptPayment): number => {
  const verified = numberValue(payment.verified_amount)
  if (verified > 0) return verified
  const detected = numberValue(payment.detected_amount)
  if (detected > 0) return detected
  return numberValue(payment.amount)
}

export const resolveTransactionReceiptAmounts = (
  payment: ReceiptPayment
): TransactionReceiptAmounts => {
  const transferFee = roundReceiptAmount(Math.max(0, numberValue(payment.transfer_fee)))
  const hasLedgerRow = payment.net_received !== undefined && payment.net_received !== null
  const netReceived = roundReceiptAmount(Math.max(0, hasLedgerRow
    ? numberValue(payment.net_received)
    : paymentNetReceived(payment)))
  const grossPaid = roundReceiptAmount(hasLedgerRow && payment.gross_paid !== undefined && payment.gross_paid !== null
    ? numberValue(payment.gross_paid)
    : netReceived + transferFee)
  const creditApplied = roundReceiptAmount(Math.max(0, numberValue(payment.credit_applied)))
  return { grossPaid, transferFee, netReceived, creditApplied }
}

export const resolveInvoiceAmounts = (booking: {
  total_amount?: number | string | null
  discount_amount_snapshot?: number | string | null
}) => {
  const totalDue = roundReceiptAmount(Math.max(0, numberValue(booking.total_amount)))
  const discount = roundReceiptAmount(Math.max(0, numberValue(booking.discount_amount_snapshot)))
  const subtotal = roundReceiptAmount(totalDue + discount)

  return {
    subtotal,
    discount,
    totalDue: roundReceiptAmount(Math.max(0, subtotal - discount)),
  }
}

/** One line on a Statement of Account (a settled credit or a refund). */
export interface StatementLine {
  receiptNumber: string
  date: string | null
  method: string
  reference: string | null
  kind: 'payment' | 'refund'
  grossPaid: number
  transferFee: number
  netReceived: number
}

/** Ledger totals printed on the Statement of Account (from booking_ledger_v). */
export interface StatementTotals {
  bookingTotal: number
  netReceived: number
  refunded: number
  netPaid: number
  balanceDue: number
  /** Part of the balance an administrator marked "to be received" (not money received). */
  deferredAmount: number
  creditHeld: number
}

/**
 * Lines for a cumulative Statement of Account, from payment_ledger_v rows
 * (is_settled_credit / is_refund). Totals must come from booking_ledger_v.
 */
export const buildStatementLines = (
  rows: Array<ReceiptPayment & { is_settled_credit?: boolean; is_refund?: boolean; recognized_at?: string | null }>
): StatementLine[] => rows
  .filter((row) => row.is_settled_credit || row.is_refund)
  .sort((a, b) => String(a.recognized_at || a.created_at || '').localeCompare(String(b.recognized_at || b.created_at || '')))
  .map((row) => {
    const amounts = resolveTransactionReceiptAmounts(row)
    const isRefund = Boolean(row.is_refund)
    return {
      receiptNumber: getReceiptNumber(row),
      date: row.recognized_at || row.verified_at || row.created_at || null,
      method: String(row.method || '').toUpperCase(),
      reference: row.reference || row.detected_ref || row.reference_number || null,
      kind: isRefund ? 'refund' : 'payment',
      grossPaid: isRefund ? 0 : amounts.grossPaid,
      transferFee: isRefund ? 0 : amounts.transferFee,
      netReceived: isRefund ? -roundReceiptAmount(Math.abs(numberValue(row.amount))) : amounts.netReceived,
    }
  })

export const statementTotalsFromLedger = (ledger: Record<string, unknown> | null | undefined): StatementTotals => ({
  bookingTotal: roundReceiptAmount(numberValue(ledger?.expected_amount)),
  netReceived: roundReceiptAmount(numberValue(ledger?.settled_amount)),
  refunded: roundReceiptAmount(numberValue(ledger?.refunded_amount)),
  netPaid: roundReceiptAmount(numberValue(ledger?.net_settled)),
  balanceDue: roundReceiptAmount(numberValue(ledger?.outstanding_amount)),
  deferredAmount: roundReceiptAmount(numberValue(ledger?.deferred_amount)),
  creditHeld: roundReceiptAmount(numberValue(ledger?.excess_amount)),
})

// ── Acknowledgement receipt wording (shared by the on-screen receipt and the emailed PDF) ──────────────────────
//
// This system is NOT a BIR-registered invoicing system (no Authority to Print, no CAS/e-invoicing
// Acknowledgement Certificate, no BIR serial range), so what it produces is a SUPPLEMENTARY document: proof
// that a payment was received. Under RR No. 7-2024 (Ease of Paying Taxes Act) the invoice is the only primary
// document, and supplementary documents must not pass for one. So these receipts:
//   - are titled "Acknowledgement Receipt" (never "official receipt" or "invoice");
//   - carry no TIN, VAT breakdown, ATP / acknowledgement certificate number or series range;
//   - say plainly that they are not valid for claim of input tax and point to the shop for a sales invoice.
export const RECEIPT_TITLE = 'ACKNOWLEDGEMENT RECEIPT'
export const REFUND_RECEIPT_TITLE = 'REFUND ACKNOWLEDGEMENT'
export const RECEIPT_TAX_NOTICE = 'THIS DOCUMENT IS NOT VALID FOR CLAIM OF INPUT TAX.'
export const RECEIPT_SYSTEM_NOTICE =
  'System-generated acknowledgement of payment. This is not a sales invoice. For a BIR-registered sales invoice, please ask the shop.'

/** Cash at the shop vs. online (GCash, Maya, bank transfer, card). */
export const isCashMethod = (method: unknown): boolean => /^(CASH|WALK_?IN|COUNTER)/i.test(String(method || ''))

const METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash', GCASH: 'GCash', MAYA: 'Maya', PAYMAYA: 'Maya', BANK_TRANSFER: 'Bank transfer', BANK: 'Bank transfer',
  CARD: 'Card', CREDIT_CARD: 'Card', QR: 'QR payment', QRPH: 'QR Ph', SYSTEM_REFUND: 'Refund', CREDIT: 'Account credit',
}
export const methodLabel = (method: unknown): string => {
  const key = String(method || '').toUpperCase().replace(/[\s-]+/g, '_')
  return METHOD_LABELS[key] || (key ? key.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase()) : 'Not recorded')
}

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
const belowThousand = (n: number): string => {
  const parts: string[] = []
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} hundred`); n %= 100 }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '')) } else if (n > 0) { parts.push(ONES[n]) }
  return parts.join(' ')
}
/** 1050.5 -> "One thousand fifty pesos and 50/100" (the way amounts are written on Philippine receipts). */
export const amountInWords = (value: unknown): string => {
  const amount = roundReceiptAmount(Math.abs(numberValue(value)))
  let whole = Math.floor(amount)
  const cents = Math.round((amount - whole) * 100)
  if (whole === 0) return `Zero pesos and ${String(cents).padStart(2, '0')}/100`
  const scales = ['', 'thousand', 'million', 'billion']
  const chunks: string[] = []
  let scale = 0
  while (whole > 0 && scale < scales.length) {
    const chunk = whole % 1000
    if (chunk) chunks.unshift(`${belowThousand(chunk)}${scales[scale] ? ` ${scales[scale]}` : ''}`)
    whole = Math.floor(whole / 1000)
    scale += 1
  }
  const words = chunks.join(' ')
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} ${Math.floor(amount) === 1 ? 'peso' : 'pesos'} and ${String(cents).padStart(2, '0')}/100`
}
