import {
  buildStatementLines,
  statementTotalsFromLedger,
  type ReceiptPayment,
  type StatementLine,
} from '../../../shared/receiptModel.ts'
import { RED, DARK, MUTED, PALE, RULE, currency, dateLabel, text, fillRect, line, assemblePdf } from './pdfDocument.ts'

/**
 * Statement of Account — the CUMULATIVE paid-to-date document, issued when a
 * booking is fully settled. Lines are payment_ledger_v rows (settled payments
 * and refunds); every total is read from booking_ledger_v, never re-summed.
 */
export interface StatementOfAccountInput {
  customerName?: string | null
  customerEmail?: string | null
  customerContact?: string | null
  bookingReference?: string | null
  /** booking_financial_ledger(booking_id) / booking_ledger_v row. */
  ledger: Record<string, unknown>
  /** payment_ledger_v rows for the booking. */
  transactions: Array<ReceiptPayment & { is_settled_credit?: boolean; is_refund?: boolean; recognized_at?: string | null }>
  issuedAt?: string | null
}

const LINES_PER_PAGE = 14

const renderStatementPage = (
  lines: StatementLine[],
  pageIndex: number,
  pageCount: number,
  input: StatementOfAccountInput,
  includeTotals: boolean
): string => {
  const ops: string[] = []
  const left = 48
  const right = 564
  const statementNo = `SOA-${String(input.bookingReference || 'N/A').toUpperCase()}`

  ops.push(text('COMAR GARAGE', left, 744, 22, 'F2', RED))
  ops.push(text('AUTO DETAILING STUDIO', left, 726, 8, 'F2', MUTED))
  ops.push(text('123 Comar Garage Drive, Quezon City, Metro Manila', left, 710, 8, 'F1', MUTED))
  ops.push(text('STATEMENT OF ACCOUNT', right, 744, 10, 'F2', RED, 'right'))
  ops.push(text(`Statement No. ${statementNo}`, right, 726, 9, 'F2', DARK, 'right'))
  ops.push(text(`Issued ${dateLabel(input.issuedAt)}`, right, 710, 8, 'F1', MUTED, 'right'))
  ops.push(line(left, 694, right, 694, DARK, 1.4))

  ops.push(text('BILLED TO', left, 672, 7, 'F2', MUTED))
  ops.push(text(input.customerName || 'Valued Customer', left, 655, 11, 'F2'))
  ops.push(text(input.customerEmail || '', left, 640, 8, 'F1', MUTED))
  if (input.customerContact) ops.push(text(input.customerContact, left, 627, 8, 'F1', MUTED))

  ops.push(text('WORK ORDER', 318, 672, 7, 'F2', MUTED))
  ops.push(text(`WO-${input.bookingReference || 'N/A'}`, 318, 655, 11, 'F2'))
  ops.push(text('All payments and refunds to date', 318, 640, 8, 'F1', MUTED))

  ops.push(fillRect(left, 580, right - left, 25, PALE))
  ops.push(text('DATE', left + 9, 589, 7, 'F2', MUTED))
  ops.push(text('RECEIPT / REFERENCE', 130, 589, 7, 'F2', MUTED))
  ops.push(text('METHOD', 318, 589, 7, 'F2', MUTED))
  ops.push(text('FEE', 440, 589, 7, 'F2', MUTED, 'right'))
  ops.push(text('NET RECEIVED', right - 9, 589, 7, 'F2', MUTED, 'right'))

  let y = 558
  for (const entry of lines) {
    const label = entry.kind === 'refund' ? 'Refund' : entry.receiptNumber
    ops.push(text(dateLabel(entry.date), left + 9, y, 8, 'F1'))
    ops.push(text(String(label).slice(0, 40), 130, y, 7, 'F1', entry.kind === 'refund' ? RED : DARK))
    if (entry.reference) ops.push(text(`Ref ${String(entry.reference).slice(0, 30)}`, 130, y - 9, 6, 'F1', MUTED))
    ops.push(text(entry.kind === 'refund' ? 'REFUND' : entry.method || '-', 318, y, 8, 'F1'))
    ops.push(text(entry.kind === 'refund' ? '-' : currency(entry.transferFee), 440, y, 8, 'F1', MUTED, 'right'))
    ops.push(text(currency(entry.netReceived), right - 9, y, 8, 'F2', entry.kind === 'refund' ? RED : DARK, 'right'))
    ops.push(line(left, y - 14, right, y - 14, RULE, 0.45))
    y -= 30
  }

  if (includeTotals) {
    const totals = statementTotalsFromLedger(input.ledger)
    const summaryLeft = 300
    let summaryY = y - 20
    const row = (label: string, value: number, bold = false) => {
      ops.push(text(label, summaryLeft, summaryY, 8, bold ? 'F2' : 'F1', bold ? DARK : MUTED))
      ops.push(text(currency(value), right, summaryY, 8, bold ? 'F2' : 'F1', DARK, 'right'))
      summaryY -= 15
    }
    ops.push(line(summaryLeft, summaryY + 10, right, summaryY + 10, DARK, 1.2))
    summaryY -= 12
    row('Booking Total', totals.bookingTotal)
    row('Total Received (net)', totals.netReceived)
    if (totals.refunded > 0) row('Less Refunds', -totals.refunded)
    row('Net Paid', totals.netPaid, true)
    if (totals.creditHeld > 0) row('Credit Held for Customer', totals.creditHeld)

    summaryY -= 3
    ops.push(fillRect(summaryLeft, summaryY - 7, right - summaryLeft, 25, PALE))
    ops.push(text('BALANCE DUE', summaryLeft + 8, summaryY + 1, 8, 'F2', DARK))
    ops.push(text(currency(totals.balanceDue), right - 8, summaryY + 1, 10, 'F2', RED, 'right'))

    ops.push(text('STATEMENT OF ACCOUNT', left, 104, 8, 'F2', RED))
    ops.push(text('Lists every verified payment and refund on this booking. Transfer fees charged', left, 89, 7, 'F1', MUTED))
    ops.push(text('by your bank or e-wallet are shown for reference and are not credited to the booking.', left, 78, 7, 'F1', MUTED))
  } else {
    ops.push(text('Continued on the next page', left, 76, 8, 'F1', MUTED))
  }

  ops.push(line(left, 58, right, 58, RULE, 0.6))
  ops.push(text(`COMAR GARAGE  |  Statement No. ${statementNo}`, left, 43, 7, 'F1', MUTED))
  ops.push(text(`Page ${pageIndex + 1} of ${pageCount}`, right, 43, 7, 'F1', MUTED, 'right'))
  return ops.join('\n')
}

export const buildStatementOfAccountPdf = (input: StatementOfAccountInput): string => {
  const lines = buildStatementLines(input.transactions || [])
  const pages: StatementLine[][] = []
  for (let index = 0; index < Math.max(lines.length, 1); index += LINES_PER_PAGE) {
    pages.push(lines.slice(index, index + LINES_PER_PAGE))
  }
  const contents = pages.map((pageLines, index) =>
    renderStatementPage(pageLines, index, pages.length, input, index === pages.length - 1)
  )
  return assemblePdf(contents)
}
