/**
 * paymentUtils.js
 * Centralized source of truth for calculating booking and payment statuses.
 */

export const calculatePaymentStatus = (booking) => {
  return calculatePaymentSummary(booking).status;
};

export const calculatePaymentSummary = (booking = {}) => {
  const payments = booking.payments || [];
  const totalAmount = Number(booking.total_amount || 0);
  const positivePayments = payments
    .filter(payment => ['PAID', 'REFUND_PENDING', 'REFUNDED'].includes(String(payment.status || '').toUpperCase()) && Number(payment.amount) > 0)
    .reduce((sum, payment) => sum + Number(payment.amount), 0);
  const processedRefunds = payments
    .filter(payment => (
      String(payment.method || '').toUpperCase() === 'SYSTEM_REFUND' && Number(payment.amount) < 0
    ) || String(payment.status || '').toUpperCase() === 'REFUNDED')
    .reduce((sum, payment) => sum + Math.abs(Number(payment.amount)), 0);
  const totalPaid = Math.max(0, positivePayments - processedRefunds);
  const refundStatus = String(booking.refund_status || '').toUpperCase();
  const hasProcessedRefund = ['PROCESSED', 'REFUNDED', 'RELEASED'].includes(refundStatus)
    || payments.some(payment => String(payment.method || '').toUpperCase() === 'SYSTEM_REFUND' && Number(payment.amount) < 0)
    || payments.some(payment => String(payment.status || '').toUpperCase() === 'REFUNDED');
  const isPendingVerification = payments.some(payment => String(payment.status || '').toUpperCase() === 'FOR_VERIFICATION');
  const requiredDownpayment = calculateRequiredDownpayment(totalAmount).amount;
  const balance = Math.max(0, totalAmount - totalPaid);

  let status = 'UNPAID';
  if (hasProcessedRefund) status = 'REFUNDED';
  else if (totalAmount > 0 && totalPaid >= totalAmount) status = 'PAID';
  else if (isPendingVerification) status = 'VERIFYING';
  else if (totalPaid >= requiredDownpayment) status = 'DOWNPAYMENT_PAID';

  return { status, totalAmount, totalPaid, processedRefunds, balance, hasProcessedRefund };
};

export const requiresDownpayment = (totalAmount) => Number(totalAmount || 0) >= 1000;

export const calculateRequiredDownpayment = (totalAmount) => {
  const total = Number(totalAmount || 0);
  const percentage = total >= 2000 ? 50 : 30;
  return {
    percentage,
    amount: Math.round(total * (percentage / 100) * 100) / 100
  };
};

export const getRequiredDownpayment = (totalAmount) => calculateRequiredDownpayment(totalAmount).amount;

export const getPaymentStatusUI = (status) => {
  switch (status) {
    case 'PAID': 
      return { label: 'FULLY PAID', color: 'var(--status-success)' };
    case 'REFUNDED':
      return { label: 'REFUNDED', color: 'var(--status-danger)' };
    case 'VERIFYING':
      return { label: 'VERIFYING', color: '#8b5cf6' };
    case 'DOWNPAYMENT_PAID':
      return { label: 'DOWNPAYMENT', color: '#3b82f6' };
    default:
      return { label: 'UNPAID', color: 'var(--status-danger)' };
  }
};
