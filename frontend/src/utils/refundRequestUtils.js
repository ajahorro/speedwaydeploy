export const getRefundRequestLimit = ({ totalPaid = 0, overpaymentRefundRemaining = 0 }) => {
  const remainingCreditRefund = Math.max(0, Number(overpaymentRefundRemaining) || 0);
  return remainingCreditRefund > 0
    ? remainingCreditRefund
    : Math.max(0, Number(totalPaid) || 0);
};

export const isPendingRefundRequest = ({ refundStatus, refundLimit }) => (
  ['PENDING', 'QUEUED', 'PROCESSING', 'EMAIL_PENDING'].includes(
    String(refundStatus || 'QUEUED').trim().toUpperCase()
  ) && Number(refundLimit) > 0
);
