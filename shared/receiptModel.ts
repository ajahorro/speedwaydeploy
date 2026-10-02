export interface ReceiptPayment {
  id?: string | null
  amount?: number | string | null
  detected_amount?: number | string | null
  net_credit?: number | string | null
  transfer_fee?: number | string | null
  credit_applied?: number | string | null
  status?: string | null
  method?: string | null
  reference_number?: string | null
  detected_ref?: string | null
  created_at?: string | null
}

export interface ReceiptRefundAllocation {
  amount?: number | string | null
  refund_payment?: {
    amount?: number | string | null
    status?: string | null
    reference_number?: string | null
    created_at?: string | null
    refunded_at?: string | null
  } | null
}

export interface TransactionReceiptAmounts {
  grossPaid: number
  transferFee: number
  netReceived: number
  creditApplied: number
  refundAmount: number
  remainingAfterRefund: number
  refundStatus: 'NOT_REFUNDED' | 'PARTIALLY_REFUNDED' | 'REFUNDED'
}

const numberValue = (value: unknown): number => {
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : 0
}

export const roundReceiptAmount = (value: number): number =>
  Math.round((numberValue(value) + Number.EPSILON) * 100) / 100

export const getReceiptNumber = (payment: ReceiptPayment): string =>
  `RCP-${String(payment.id || 'UNKNOWN').toUpperCase()}`

export const resolveTransactionReceiptAmounts = (
  payment: ReceiptPayment,
  refundAllocations: ReceiptRefundAllocation[] = []
): TransactionReceiptAmounts => {
  const declaredAmount = Math.max(0, numberValue(payment.amount))
  const detectedNet = Math.max(0, numberValue(payment.detected_amount))
  const recordedNetCredit = Math.max(0, numberValue(payment.net_credit))
  const transferFee = Math.max(0, numberValue(payment.transfer_fee))
  const netReceived = roundReceiptAmount(
    detectedNet || recordedNetCredit || Math.max(0, declaredAmount - transferFee)
  )
  const grossPaid = roundReceiptAmount(
    detectedNet > 0
      ? detectedNet + transferFee
      : declaredAmount > 0
        ? declaredAmount
        : netReceived + transferFee
  )
  const creditApplied = roundReceiptAmount(Math.max(0, numberValue(payment.credit_applied)))
  const processedRefunds = refundAllocations.filter((allocation) =>
    String(allocation.refund_payment?.status || '').toUpperCase() === 'REFUNDED'
  )
  const refundAmount = roundReceiptAmount(processedRefunds.reduce(
    (total, allocation) => total + Math.max(0, numberValue(allocation.amount)),
    0
  ))
  const remainingAfterRefund = roundReceiptAmount(Math.max(0, declaredAmount - refundAmount))
  const refundStatus = refundAmount <= 0
    ? 'NOT_REFUNDED'
    : remainingAfterRefund <= 0
      ? 'REFUNDED'
      : 'PARTIALLY_REFUNDED'

  return {
    grossPaid,
    transferFee,
    netReceived,
    creditApplied,
    refundAmount,
    remainingAfterRefund,
    refundStatus,
  }
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
