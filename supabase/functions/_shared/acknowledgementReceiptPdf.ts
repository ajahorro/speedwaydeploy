import {
  RECEIPT_SYSTEM_NOTICE,
  RECEIPT_TAX_NOTICE,
  RECEIPT_TITLE,
  amountInWords,
  getReceiptNumber,
  isCashMethod,
  methodLabel,
  resolveTransactionReceiptAmounts,
  type ReceiptPayment,
} from '../../../shared/receiptModel.ts'
import { RED, DARK, MUTED, PALE, RULE, currency, text, fillRect, line, strokeRect, wrapText, assemblePdf } from './pdfDocument.ts'

/**
 * The emailed ACKNOWLEDGEMENT RECEIPT (PDF) for one verified payment. Same content and wording as the on-screen
 * receipt (frontend/src/components/PaymentReceipt.jsx): the shop at the top, receipt number and date, cash or
 * online, who paid, what for, the totals, "received the amount of" in figures and words, and the notice that it
 * is not a sales invoice and not valid for claim of input tax. No TIN, VAT breakdown, ATP, acknowledgement
 * certificate or series range: the system is not a BIR-registered invoicing system.
 */
export interface ReceiptShop {
  name?: string | null
  address?: string | null
  phone?: string | null
  email?: string | null
}
export interface ReceiptItem {
  description: string
  amount: number
}
export interface AcknowledgementReceiptPdfInput {
  shop?: ReceiptShop | null
  customerName?: string | null
  customerEmail?: string | null
  customerContact?: string | null
  bookingReference?: string | null
  appointmentAt?: string | null
  items?: ReceiptItem[]
  bookingSubtotal?: number
  discount?: number
  amountDue?: number
  /** Money counted toward the booking before this payment (null when unknown). */
  paidBefore?: number | null
  /** Balance after this payment (null when unknown). */
  balanceAfter?: number | null
  payment: ReceiptPayment
}

const MANILA = 'Asia/Manila'
const fmtDate = (value?: string | null) => {
  const d = value ? new Date(value) : new Date()
  return Number.isNaN(d.getTime()) ? '-' : new Intl.DateTimeFormat('en-PH', { timeZone: MANILA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}
const fmtDateTime = (value?: string | null) => {
  const d = value ? new Date(value) : new Date()
  return Number.isNaN(d.getTime()) ? '-' : new Intl.DateTimeFormat('en-PH', { timeZone: MANILA, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d)
}
const titleCase = (s: unknown) => String(s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())

/** a key/value table: label band + rows, drawn top-down from `top` */
const kvBox = (ops: string[], x: number, top: number, width: number, labelText: string, rows: Array<[string, string, boolean?]>, keyWidth: number, alignRight = false): number => {
  const rowH = 17
  const height = 18 + rows.length * rowH
  ops.push(fillRect(x, top - 18, width, 18, PALE))
  ops.push(strokeRect(x, top - height, width, height))
  ops.push(line(x, top - 18, x + width, top - 18, DARK, 0.8))
  ops.push(text(labelText.toUpperCase(), x + 8, top - 12.5, 7.5, 'F2', DARK))
  rows.forEach(([k, v, strong], i) => {
    const y = top - 18 - (i + 1) * rowH + 5.5
    if (i > 0) ops.push(line(x, top - 18 - i * rowH, x + width, top - 18 - i * rowH, RULE, 0.5))
    ops.push(text(k, x + 8, y, 8, strong ? 'F2' : 'F1', strong ? DARK : MUTED))
    const value = String(v).slice(0, Math.floor((width - keyWidth - 14) / 4.2))
    ops.push(text(value, alignRight ? x + width - 8 : x + keyWidth, y, 8.5, strong ? 'F2' : 'F1', DARK, alignRight ? 'right' : 'left'))
  })
  ops.push(line(x + keyWidth - 6, top - 18, x + keyWidth - 6, top - height, RULE, 0.5))
  return top - height
}

export const buildAcknowledgementReceiptPdf = (input: AcknowledgementReceiptPdfInput): string => {
  const ops: string[] = []
  const pay = resolveTransactionReceiptAmounts(input.payment)
  const thisPayment = pay.netReceived + pay.creditApplied
  const number = getReceiptNumber(input.payment)
  const method = input.payment.method
  const cash = isCashMethod(method)
  const reference = input.payment.reference || input.payment.reference_number || input.payment.detected_ref || ''
  const shopName = titleCase(input.shop?.name || 'Comar Garage')
  const L = 48
  const R = 564

  // ── shop (left) and document (right) ──
  ops.push(text(shopName, L, 742, 17, 'F2', DARK))
  let sy = 726
  if (input.shop?.address) { ops.push(text(String(input.shop.address).slice(0, 70), L, sy, 8.5, 'F1', MUTED)); sy -= 12 }
  const contact = [input.shop?.phone, input.shop?.email].filter(Boolean).join('  |  ')
  if (contact) { ops.push(text(contact, L, sy, 8.5, 'F1', MUTED)); sy -= 12 }
  ops.push(text('comargarage.com', L, sy, 8.5, 'F1', MUTED))

  ops.push(text(RECEIPT_TITLE, R, 742, 13, 'F2', RED, 'right'))
  ops.push(text(`Receipt no.  ${number}`, R, 726, 9, 'F2', DARK, 'right'))
  ops.push(strokeRect(R - 170, 692, 170, 20))
  ops.push(line(R - 110, 692, R - 110, 712, DARK, 0.8))
  ops.push(text('Date', R - 160, 698.5, 9, 'F1', MUTED))
  ops.push(text(fmtDate(input.payment.verified_at || input.payment.created_at), R - 8, 698.5, 9.5, 'F2', DARK, 'right'))

  // ── cash / online ──
  const box = (x: number, checked: boolean, labelText: string) => {
    ops.push(strokeRect(x, 662, 11, 11, DARK, 1))
    if (checked) ops.push(text('X', x + 2.4, 664.3, 9, 'F2', DARK))
    ops.push(text(labelText, x + 18, 664, 9.5, 'F2', DARK))
  }
  box(L, cash, 'CASH')
  box(L + 90, !cash, `ONLINE${!cash && method ? ` (${methodLabel(method)})` : ''}`)

  // ── received from ──
  let y = kvBox(ops, L, 648, R - L, 'Received from', [
    ['Name', input.customerName || '-'],
    ['Contact', [input.customerContact, input.customerEmail].filter(Boolean).join('  |  ') || '-'],
    ['Booking no.', `${input.bookingReference || '-'}${input.appointmentAt ? `   (appointment ${fmtDateTime(input.appointmentAt)})` : ''}`],
  ], 90)

  // ── items ──
  y -= 14
  const cols = [L, 330, 380, 470, R]
  const headH = 20
  ops.push(fillRect(L, y - headH, R - L, headH, PALE))
  ops.push(text('DESCRIPTION / NATURE OF SERVICE', L + 8, y - 13.5, 7.5, 'F2', DARK))
  ops.push(text('QTY', 355, y - 13.5, 7.5, 'F2', DARK, 'right'))
  ops.push(text('UNIT PRICE', 462, y - 13.5, 7.5, 'F2', DARK, 'right'))
  ops.push(text('AMOUNT', R - 8, y - 13.5, 7.5, 'F2', DARK, 'right'))
  const tableTop = y
  y -= headH
  const items = (input.items && input.items.length ? input.items : [{ description: 'Car care services', amount: input.amountDue ?? thisPayment }]).slice(0, 12)
  const rows: Array<[string, string, string, string]> = items.map((it) => [String(it.description).slice(0, 52), '1', currency(it.amount), currency(it.amount)])
  if ((input.discount || 0) > 0) rows.push(['Less: discount', '', '', `- ${currency(input.discount || 0)}`])
  for (const r of rows) {
    ops.push(line(L, y, R, y, DARK, 0.6))
    ops.push(text(r[0], L + 8, y - 13, 8.5, 'F1', DARK))
    ops.push(text(r[1], 355, y - 13, 8.5, 'F1', DARK, 'right'))
    ops.push(text(r[2], 462, y - 13, 8.5, 'F1', DARK, 'right'))
    ops.push(text(r[3], R - 8, y - 13, 8.5, 'F1', DARK, 'right'))
    y -= 19
  }
  ops.push(strokeRect(L, y, R - L, tableTop - y))
  cols.slice(1, -1).forEach((cx) => ops.push(line(cx, tableTop, cx, y, DARK, 0.6)))

  // ── payment details (left) and summary (right) ──
  y -= 14
  const mid = (L + R) / 2
  const leftBottom = kvBox(ops, L, y, mid - L - 6, 'Payment details', [
    ['Paid by', cash ? 'Cash' : methodLabel(method)],
    ['Reference no.', reference || (cash ? 'Paid at the shop' : 'Not provided')],
    ['Recorded', fmtDateTime(input.payment.verified_at || input.payment.created_at)],
    ...(pay.transferFee > 0 ? [['Transfer fee', `${currency(pay.transferFee)} (payment app)`] as [string, string]] : []),
  ], 82)
  const summary: Array<[string, string, boolean?]> = [
    ['Booking total', currency(input.bookingSubtotal ?? input.amountDue ?? thisPayment)],
  ]
  if ((input.discount || 0) > 0) summary.push(['Less: discount', `- ${currency(input.discount || 0)}`])
  summary.push(['Amount due', currency(input.amountDue ?? thisPayment)])
  if (input.paidBefore !== null && input.paidBefore !== undefined) summary.push(['Paid before this', currency(input.paidBefore)])
  if (pay.creditApplied > 0) summary.push(['Account credit used', currency(pay.creditApplied)])
  summary.push(['This payment', currency(thisPayment), true])
  if (input.balanceAfter !== null && input.balanceAfter !== undefined) summary.push(['Balance remaining', currency(input.balanceAfter)])
  const rightBottom = kvBox(ops, mid + 6, y, R - mid - 6, 'Summary', summary, 110, true)
  y = Math.min(leftBottom, rightBottom) - 26

  // ── received the amount of ──
  ops.push(strokeRect(L, y - 1, 11, 11, DARK, 1))
  ops.push(text('X', L + 2.4, y + 1.3, 9, 'F2', DARK))
  ops.push(text('Received the amount of', L + 18, y + 1, 9.5, 'F1', DARK))
  ops.push(line(L + 140, y - 2, R, y - 2, DARK, 0.8))
  ops.push(text(currency(thisPayment), (L + 140 + R) / 2 + 30, y + 1, 11, 'F2', DARK, 'right'))
  ops.push(text(amountInWords(thisPayment), L + 140, y - 14, 8.5, 'F3', MUTED))

  // ── footer ──
  ops.push(line(L, 104, R, 104, RULE, 0.6))
  ops.push(text(RECEIPT_TAX_NOTICE, L, 90, 8.5, 'F2', DARK))
  wrapText(RECEIPT_SYSTEM_NOTICE, 120).forEach((t, i) => ops.push(text(t, L, 77 - i * 11, 7.5, 'F1', MUTED)))
  ops.push(text(`Generated by the ${shopName} booking system (comargarage.com) on ${fmtDateTime(null)}.`, L, 53, 7.5, 'F1', MUTED))
  ops.push(text(`Receipt no. ${number}  |  Page 1 of 1`, R, 38, 7, 'F1', MUTED, 'right'))

  return assemblePdf([ops.join('\n')])
}
