import {
  getReceiptNumber,
  resolveTransactionReceiptAmounts,
  type ReceiptPayment,
} from '../../../shared/receiptModel.ts'
import { RED, DARK, MUTED, PALE, RULE, currency, dateLabel, text, fillRect, line, assemblePdf } from './pdfDocument.ts'

export interface OfficialReceiptPdfItem {
  vehicle?: string
  service?: string
  qty?: number
  unitPrice?: number
  lineTotal?: number
}

export interface OfficialReceiptPdfInput {
  customerName?: string | null
  customerEmail?: string | null
  customerContact?: string | null
  bookingReference?: string | null
  payment: ReceiptPayment
}

const renderPage = (
  items: OfficialReceiptPdfItem[],
  pageIndex: number,
  pageCount: number,
  input: OfficialReceiptPdfInput,
  includeTotals: boolean
): string => {
  const ops: string[] = []
  const amounts = resolveTransactionReceiptAmounts(input.payment)
  const receiptNumber = getReceiptNumber(input.payment)
  const referenceId = input.payment.reference || input.payment.reference_number || input.payment.detected_ref || 'Not provided'
  const left = 48
  const right = 564

  ops.push(text('COMAR GARAGE', left, 744, 22, 'F2', RED))
  ops.push(text('AUTO DETAILING STUDIO', left, 726, 8, 'F2', MUTED))
  ops.push(text('123 Comar Garage Drive, Quezon City, Metro Manila', left, 710, 8, 'F1', MUTED))
  ops.push(text('OFFICIAL RECEIPT', right, 744, 10, 'F2', RED, 'right'))
  ops.push(text(`Receipt No. ${receiptNumber}`, right, 726, 9, 'F2', DARK, 'right'))
  ops.push(text(dateLabel(input.payment.verified_at || input.payment.created_at), right, 710, 8, 'F1', MUTED, 'right'))
  ops.push(line(left, 694, right, 694, DARK, 1.4))

  ops.push(text('BILLED TO', left, 672, 7, 'F2', MUTED))
  ops.push(text(input.customerName || 'Valued Customer', left, 655, 11, 'F2'))
  ops.push(text(input.customerEmail || '', left, 640, 8, 'F1', MUTED))
  if (input.customerContact) ops.push(text(input.customerContact, left, 627, 8, 'F1', MUTED))

  ops.push(text('WORK ORDER', 318, 672, 7, 'F2', MUTED))
  ops.push(text(`WO-${input.bookingReference || 'N/A'}`, 318, 655, 11, 'F2'))
  ops.push(text(input.payment.method || 'Digital / Online Payment', 318, 640, 8, 'F1', MUTED))
  ops.push(text(`Transaction/Reference ID: ${referenceId}`, 318, 627, 7, 'F1', MUTED))

  ops.push(fillRect(left, 580, right - left, 25, PALE))
  ops.push(text('DESCRIPTION', left + 9, 589, 7, 'F2', MUTED))
  ops.push(text('QTY', 393, 589, 7, 'F2', MUTED, 'right'))
  ops.push(text('UNIT PRICE', 475, 589, 7, 'F2', MUTED, 'right'))
  ops.push(text('TOTAL', right - 9, 589, 7, 'F2', MUTED, 'right'))

  let y = 558
  for (const item of items) {
    const vehicle = String(item.vehicle || '').trim()
    const service = String(item.service || 'Service').trim()
    const description = [vehicle, service].filter(Boolean).join(' - ')
    const quantity = Number(item.qty ?? 1)
    const unitPrice = Number(item.unitPrice ?? item.lineTotal ?? 0)
    const lineTotal = Number(item.lineTotal ?? unitPrice * quantity)

    ops.push(text(description.slice(0, 68), left + 9, y, 8, 'F1'))
    ops.push(text(String(quantity), 393, y, 8, 'F1', DARK, 'right'))
    ops.push(text(currency(unitPrice), 475, y, 8, 'F1', DARK, 'right'))
    ops.push(text(currency(lineTotal), right - 9, y, 8, 'F2', DARK, 'right'))
    ops.push(line(left, y - 8, right, y - 8, RULE, 0.45))
    y -= 25
  }

  if (includeTotals) {
    const summaryTop = y - 24
    const summaryLeft = 300
    const summaryRight = right
    let summaryY = summaryTop

    ops.push(line(summaryLeft, summaryY + 10, summaryRight, summaryY + 10, DARK, 1.2))
    summaryY -= 12
    ops.push(text('Gross Paid', summaryLeft, summaryY, 8, 'F1', MUTED))
    ops.push(text(currency(amounts.grossPaid), summaryRight, summaryY, 8, 'F1', DARK, 'right'))
    summaryY -= 15
    ops.push(text('Transfer Fee', summaryLeft, summaryY, 8, 'F1', MUTED))
    ops.push(text(currency(amounts.transferFee), summaryRight, summaryY, 8, 'F1', DARK, 'right'))
    summaryY -= 15
    ops.push(text('Net Received', summaryLeft, summaryY, 8, 'F1', MUTED))
    ops.push(text(currency(amounts.netReceived), summaryRight, summaryY, 8, 'F1', DARK, 'right'))

    if (amounts.creditApplied > 0) {
      summaryY -= 15
      ops.push(text('Credit Applied', summaryLeft, summaryY, 8, 'F1', MUTED))
      ops.push(text(currency(amounts.creditApplied), summaryRight, summaryY, 8, 'F1', DARK, 'right'))
    }

    summaryY -= 18
    ops.push(fillRect(summaryLeft, summaryY - 7, summaryRight - summaryLeft, 25, PALE))
    ops.push(text('NET RECEIVED', summaryLeft + 8, summaryY + 1, 8, 'F2', DARK))
    ops.push(text(currency(amounts.netReceived), summaryRight - 8, summaryY + 1, 10, 'F2', RED, 'right'))

    ops.push(text('PAYMENT RECEIPT', left, 91, 8, 'F2', RED))
    ops.push(text('This receipt records one payment transaction.', left, 76, 8, 'F1', MUTED))
  } else {
    ops.push(text('Continued on the next page', left, 76, 8, 'F1', MUTED))
  }

  ops.push(line(left, 58, right, 58, RULE, 0.6))
  ops.push(text(`COMAR GARAGE  |  Receipt No. ${receiptNumber}`, left, 43, 7, 'F1', MUTED))
  ops.push(text(`Page ${pageIndex + 1} of ${pageCount}`, right, 43, 7, 'F1', MUTED, 'right'))
  return ops.join('\n')
}

export const buildOfficialReceiptPdf = (input: OfficialReceiptPdfInput): string => {
  const amounts = resolveTransactionReceiptAmounts(input.payment)
  const normalizedItems = [{
    service: 'Payment for Booking',
    qty: 1,
    unitPrice: amounts.grossPaid,
    lineTotal: amounts.grossPaid,
  }]
  const pageSize = 12
  const itemPages: OfficialReceiptPdfItem[][] = []
  for (let index = 0; index < normalizedItems.length; index += pageSize) {
    itemPages.push(normalizedItems.slice(index, index + pageSize))
  }
  const pageCount = itemPages.length
  const pageContents = itemPages.map((pageItems, index) =>
    renderPage(pageItems, index, pageCount, input, index === pageCount - 1)
  )

  return assemblePdf(pageContents)
}
