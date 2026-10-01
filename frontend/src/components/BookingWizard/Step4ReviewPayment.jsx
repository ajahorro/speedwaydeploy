import React, { useState, useEffect, useRef } from 'react';
import { Upload, CheckCircle2, Wallet, Banknote, ShieldAlert, AlertTriangle, Package as PackageIcon, Hash, Camera } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useConfig } from '../../context/ConfigContext';
import { calculateBookingDiscountSummary, validateServiceRequirements, describeServiceRequirementViolation } from '../../data/servicesCatalog';
import { getRequiredDownpayment, requiresDownpayment } from '../../utils/paymentUtils';
import QRMagnifier from '../QRMagnifier';
import { captureQrSnapshot } from '../../services/qrSecurityService';
import { computeNetCredit } from '../../services/creditLedgerService';
import { sanitizeCurrency } from '../../config/constants';
import { logger } from '../../utils/logger';
import toastManager from '../../utils/toastManager';
import { BACKEND_URL } from '../../config/api';

const Step4ReviewPayment = ({ bookingData, setBookingData, adminMode = false, onNext, onBack, onSubmit, isSubmitting, onCancel }) => {
  const { settings } = useConfig();
  const [isUploading, setIsUploading] = useState(false);
  const [receiptDetails, setReceiptDetails] = useState(null);
  const [adminDigitalMode, setAdminDigitalMode] = useState('ocr'); // 'ocr' | 'reference'
  const [manualRefInput, setManualRefInput] = useState(bookingData.payment?.manualRefNumber || bookingData.payment?.referenceNumber || '');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showHelpTips, setShowHelpTips] = useState(false);
  // Synchronous submit lock (defence in depth). The parent's `isSubmitting` prop
  // is async, so this ref guarantees `onSubmit` can fire at most once even if the
  // confirm button is double-clicked or double-tapped in the same tick.
  const confirmInFlight = useRef(false);

  // Task B: freeze the QR target for THIS checkout session.
  // Captured once when the payment step mounts. A mid-update QR change by an
  // admin afterwards cannot break this payment, because everything below reads
  // from `qrTarget` (the snapshot), not the live settings.
  const [qrTarget, setQrTarget] = useState(null);

  useEffect(() => {
    const existingBookingId = bookingData?.bookingId || bookingData?.id || null;
    const snapshot = {
      QR_ACCOUNT_NAME: settings.qr_account_name || settings.QR_ACCOUNT_NAME || settings.PAYMENT_ACCOUNT_NAME || '',
      QR_ACCOUNT_NUMBER: settings.qr_account_number || settings.QR_ACCOUNT_NUMBER || settings.PAYMENT_ACCOUNT_NUMBER || '',
      PAYMENT_QR_URL: settings.qr_code_url || settings.PAYMENT_QR_URL || null,
      QR_CONFIG_VERSION: settings.QR_CONFIG_VERSION ?? 1,
    };
    setQrTarget(snapshot);

    // 🛡️ SCENARIO 8 — FREEZE THE QR TARGET ON A BRAND-NEW BOOKING TOO.
    // Previously the snapshot was only persisted when a booking row already
    // existed (reschedule/admin). For a brand-new customer booking the row is
    // created at submit time and read `bookingData.qrSnapshot` — which nothing
    // ever set, so `active_qr_snapshot` landed NULL and the checkout fell back to
    // the LIVE config. A mid-checkout QR swap therefore silently changed the
    // target the customer was about to scan. We now park the frozen snapshot on
    // the wizard state so the booking is created already locked to the QR the
    // customer was shown.
    if (!existingBookingId) {
      setBookingData((current) => {
        if (current.qrSnapshot?.qr_config_version === snapshot.QR_CONFIG_VERSION && current.qrSnapshot?.qr_account_number === snapshot.QR_ACCOUNT_NUMBER) {
          return current;
        }
        return {
          ...current,
          qrSnapshot: {
            qr_account_name: snapshot.QR_ACCOUNT_NAME,
            qr_account_number: snapshot.QR_ACCOUNT_NUMBER,
            payment_qr_url: snapshot.PAYMENT_QR_URL,
            gcash_qr_url: snapshot.PAYMENT_QR_URL,
            qr_photo_url: snapshot.PAYMENT_QR_URL,
            qr_config_version: snapshot.QR_CONFIG_VERSION,
            captured_at: new Date().toISOString(),
          },
        };
      });
    }

    // Persist the snapshot onto the booking row when we already have one
    // (reschedule / admin / draft). For a brand-new customer booking the row is
    // written at submit time and the snapshot is stored then.
    if (existingBookingId) {
      captureQrSnapshot(existingBookingId, {
        qr_account_name: snapshot.QR_ACCOUNT_NAME,
        qr_account_number: snapshot.QR_ACCOUNT_NUMBER,
        gcash_qr_url: snapshot.PAYMENT_QR_URL,
        qr_config_version: snapshot.QR_CONFIG_VERSION,
      }).catch((err) => logger.warn('QR snapshot capture skipped', err));
    }
    // Intentionally depends only on the booking id: the snapshot must NOT be
    // refreshed by a live settings change mid-checkout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingData?.bookingId, bookingData?.id]);

  const labelStyle = {
    fontSize: '0.65rem',
    fontWeight: '950',
    color: 'var(--admin-text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '1px',
    marginBottom: '0.5rem',
    display: 'block'
  };
  const vehicles = bookingData.vehicles || [];
  // Section 4: evaluate promo eligibility against the booking's creation date,
  // never the live clock, so the quoted discount matches the rule set in force
  // when the booking was made.
  const promoReferenceDate = bookingData.createdAt || bookingData.created_at || bookingData.submittedAt || null;
  const promoSummary = calculateBookingDiscountSummary(vehicles, promoReferenceDate);
  const grandTotal = promoSummary.discountedTotal;

  // Removed local fetchConfig - now using useConfig hook for global settings

  const [scanStep, setScanStep] = useState('');

  /**
   * Monotonic scan id. Every upload claims the next value and only writes its
   * result if it is STILL the newest when it resolves.
   *
   * WHY: `handleFileUpload` is fully async — Tesseract init, recognition, then a
   * network verify. Nothing stopped a second upload starting before the first
   * finished. Because the SLOWER scan resolves LAST, its `setReceiptDetails` won:
   * the UI showed the result of the receipt the user had already replaced. In the
   * worst case that meant a stale REJECTION overriding a fresh MATCH, or vice
   * versa, with no way for the customer to tell which was current.
   *
   * A ref (not state) because the guard must be read/written synchronously inside
   * the async handler, before any re-render.
   */
  const scanIdRef = useRef(0);

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      // 🔄 RESET: Clear the input so selecting the same file again triggers onChange
      e.target.value = null;

      // Claim this scan. Any in-flight scan now knows it is stale.
      const scanId = ++scanIdRef.current;
      const isStale = () => scanIdRef.current !== scanId;

      setIsUploading(true);
      setReceiptDetails(null);
      setScanStep('READING RECEIPT...');

      // Save the file reference
      setBookingData(prev => ({
        ...prev,
        payment: { ...prev.payment, proofOfPayment: file, ocrData: null }
      }));

      try {
        const paymentType = bookingData.payment?.type || 'Full';
        const targetAmount = paymentType === 'Downpayment' ? getRequiredDownpayment(grandTotal) : grandTotal;
        // The shop's registered payee for THIS checkout (config.qr_account_name).
        // The backend compares the receipt's recipient against this BEFORE it
        // parses amounts, so a wrong payee aborts the scan immediately.
        const expectedRecipientName = qrTarget?.QR_ACCOUNT_NAME || settings.qr_account_name || settings.QR_ACCOUNT_NAME || settings.PAYMENT_ACCOUNT_NAME || '';

        setScanStep('SCANNING RECEIPT ON SERVER...');

        // A newer scan owns the UI and its eventual server-issued scan session.
        if (isStale()) return;

        const formData = new FormData();
        // The server performs OCR and hashes these exact uploaded bytes.
        formData.append('receipt', file);
        formData.append('bookingId', bookingData.id || 'PENDING');
        formData.append('requiredAmount', targetAmount);
        formData.append('fullAmount', grandTotal);
        formData.append('paymentType', paymentType);
        // 🛡️ SCENARIO 8 — GHOST QR CODE SWAP.
        // The customer has been sitting on this checkout for minutes; the admin
        // just swapped the store QR image. The customer scanned the QR that was ON
        // THEIR SCREEN (frozen by captureQrSnapshot into this booking), so we tell
        // the verifier WHICH QR config version this receipt must belong to. The
        // backend flags a receipt whose payee does not match the frozen snapshot's
        // account, and the version is persisted so the admin can see the customer
        // paid a now-superseded QR instead of silently accepting a receipt for an
        // image the shop no longer displays.
        formData.append('expectedQrVersion', String(qrTarget?.QR_CONFIG_VERSION ?? ''));

        let result;
        try {
          const controller = new AbortController();
          const timeoutId = window.setTimeout(() => controller.abort(), 140000);
          let response;
          try {
            response = await fetch(`${BACKEND_URL}/api/ocr/verify-receipt`, {
              method: 'POST',
              body: formData,
              signal: controller.signal
            });
          } finally {
            window.clearTimeout(timeoutId);
          }

          // 🛡️ SC-18 — RATE LIMIT (429) SURFACING.
          // The server now throttles scans and locks automation after repeated
          // failures. A 429 must tell the user exactly how long to wait instead
          // of silently collapsing into the generic "service unavailable" path.
          if (response.status === 429) {
            const errData = await response.json().catch(() => ({}));
            const waitSeconds = Number(errData.retryAfterSeconds || 30);
            // A superseded scan must not clear the spinner the NEWER scan owns.
            if (isStale()) return;
            setScanStep('');
            setIsUploading(false);
            setReceiptDetails({
              valid: false,
              status: 'RATE_LIMITED',
              reason: 'RATE_LIMITED',
              amount: 0,
              referenceNo: null,
              description: `Too many receipt scans in a short period. Please wait ${waitSeconds} second(s) before trying again.`,
              manualReviewAllowed: false,
            });
            toastManager.error(`Please wait ${waitSeconds}s before scanning another receipt.`);
            return;
          }

          if (response.status === 413) {
            const errData = await response.json().catch(() => ({}));
            if (isStale()) return;
            setScanStep('');
            setIsUploading(false);
            setReceiptDetails({
              valid: false,
              status: 'FILE_TOO_LARGE',
              reason: 'FILE_TOO_LARGE',
              amount: 0,
              referenceNo: null,
              description: errData.error || 'That image is too large. Please upload a smaller photo of your receipt.',
              manualReviewAllowed: false,
            });
            toastManager.error('Receipt image is too large. Please upload a smaller photo.');
            return;
          }

          if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || 'Verification service unavailable');
          }

          result = await response.json();
          console.log('🔍 [OCR AUDIT] Verification result received:', result);
        } catch (verifyErr) {
          console.warn('⚠️ [OCR AUDIT] Server verification failed; no scan session was issued:', verifyErr.message);
          throw new Error(describeOcrFailure(verifyErr));
        }

        if (!result.success) throw new Error(result.error);

        const extractedData = result.data;

        // 🛡️ THESIS FLOW: Use the Authoritative Backend Status
        // `valid` is the fail-fast verdict: true only on MATCH_SUCCESS.
        const isValidReceipt = result.valid === true;
        const isNameMatched = (result.isNameMatch ?? extractedData.isNameMatch) !== false;
        const isAmountMatched = result.isAmountMatch ?? result.isMatch ?? extractedData.isAmountMatch;
        const isDateMatched = (result.isDateMatch ?? extractedData.isDateMatch) !== false;
        const isDuplicate = Boolean(result.isDuplicate);

        // The 800 ms "FINALIZING AUDIT" beat is cosmetic. Re-check staleness
        // afterwards: a newer scan may have started during it.
        setScanStep('FINALIZING AUDIT...');
        await new Promise(resolve => setTimeout(resolve, 800));

        if (isStale()) return;

        // A rejected receipt (bad payee, wrong amount, stale date, or reuse) is
        // reported so the UI hard-blocks the submit button and offers a re-upload.
        // EXCEPTION: when the OCR engine itself was unreachable, the receipt is
        // accepted for manual review and submit stays enabled.
        const manualReviewAllowed = Boolean(result.manualReviewAllowed);
        const resultObj = {
          valid: isValidReceipt,
          reason: result.reason || null,
          referenceNo: extractedData.referenceNo,
          amount: extractedData.amount,
          amountDetected: extractedData.amountDetected === undefined
            ? extractedData.amount !== null && extractedData.amount !== undefined
            : Boolean(extractedData.amountDetected),
          requiredAmount: targetAmount,
          fullAmount: Number(extractedData.fullAmount || grandTotal),
          date: extractedData.date,
          status: manualReviewAllowed
            ? 'MANUAL_REVIEW'
            : (isValidReceipt
              ? 'MATCHED'
              : (isDuplicate
                ? 'DUPLICATE_DETECTED'
                : (!isNameMatched
                  ? 'NAME_MISMATCH'
                  : (!isDateMatched ? 'DATE_MISMATCH' : (!isAmountMatched ? 'MISMATCHED' : 'REJECTED'))))),
          isNameMatch: isNameMatched,
          isAmountMatch: isAmountMatched,
          isDuplicate,
          isDateMatch: isDateMatched,
          isReferenceValid: (result.isReferenceValid ?? extractedData.isReferenceValid) === true,
          isReferenceUnique: (result.isReferenceUnique ?? extractedData.isReferenceUnique) === true,
          validationErrors: Array.isArray(result.validationErrors)
            ? result.validationErrors
            : (Array.isArray(extractedData.validationErrors) ? extractedData.validationErrors : []),
          isManualReview: Boolean(result.isManualReview),
          verificationUnavailable: Boolean(result.verificationUnavailable),
          manualReviewAllowed,
          ocrScanId: result.ocrScanId || null,
          receiptUrl: result.receiptUrl || null,
          recipient: extractedData.recipient || 'N/A',
          expectedRecipientName: extractedData.expectedRecipientName || expectedRecipientName,
          // Scenario 8: record the frozen QR version this receipt was checked
          // against, so a payment made via a superseded QR is traceable.
          qrConfigVersion: qrTarget?.QR_CONFIG_VERSION ?? null,
          recipientMatch: isNameMatched,
          description: manualReviewAllowed
            ? (extractedData.description || 'This receipt will be reviewed by staff.')
            : (extractedData.description || '')
        };

        if (isStale()) return;

        setReceiptDetails(resultObj);

        // SYNC TO MASTER STATE
        setBookingData(prev => ({
          ...prev,
          payment: { ...prev.payment, ocrData: resultObj }
        }));

      } catch (err) {
        // A superseded scan must not paint an error over the newer scan's UI.
        if (isStale()) return;
        const friendlyMessage = describeOcrFailure(err);
        setReceiptDetails({
          status: 'REJECTED',
          error: 'RECEIPT VERIFICATION FAILED',
          description: friendlyMessage
        });
      } finally {
        // Only the newest scan owns `isUploading`/`scanStep`. Without this guard a
        // stale scan finishing later would clear the spinner while the newer scan
        // is still running — the button would re-enable and accept a submit
        // against a receipt that is not yet verified.
        if (!isStale()) {
          setIsUploading(false);
          setScanStep('');
        }
      }
    }
  };

  const isGcash = bookingData.payment.method === 'GCash';
  const isDuplicateReceipt = Boolean(receiptDetails?.isDuplicate);
  const isNameMismatch = receiptDetails?.isNameMatch === false;
  const isReceiptRejected = receiptDetails?.status === 'REJECTED';
  // DIRECTIVE 1: HARD-BLOCKING VALIDATION — with one exception.
  // A GCash (digital) booking may only be submitted once the receipt is EITHER
  // auto-verified (MATCH_SUCCESS) OR the OCR engine was unreachable and the
  // receipt was accepted for MANUAL admin review. Any real mismatch still keeps
  // the submit button disabled. Admin-created bookings bypass this gate.
  const manualReviewAllowedReceipt = Boolean(receiptDetails?.manualReviewAllowed);
  const receiptVerified = Boolean(receiptDetails?.valid === true) || manualReviewAllowedReceipt;
  const serverValidationErrors = Array.isArray(receiptDetails?.validationErrors)
    ? receiptDetails.validationErrors
    : [];
  const receiptValidationErrors = serverValidationErrors.length > 0
    ? serverValidationErrors
    : (receiptDetails && !receiptVerified
      ? [{
          code: 'VERIFICATION_FAILED',
          message: receiptDetails.description || 'We could not read enough of this receipt. Try a clear, complete photo or contact support.',
        }]
      : []);
  const receiptStatusLabel = manualReviewAllowedReceipt
    ? 'Pending Manual Review'
    : receiptVerified
      ? 'Receipt Verified'
      : receiptValidationErrors.length > 1
        ? 'Multiple Validation Issues'
        : (receiptValidationErrors[0]?.label || 'Receipt Needs Review');
  // A verifier outage is shown as pending manual review, not as a customer error.
  const isReceiptBlocked = !adminMode && receiptDetails && !receiptVerified;
  const downpaymentAmount = getRequiredDownpayment(grandTotal);
  const isUnderpaidReceipt = Boolean(
    !adminMode &&
    bookingData.payment.method === 'GCash' &&
    receiptDetails &&
    !receiptDetails.isManualReview &&
    receiptDetails.amountDetected === true &&
    Number.isFinite(Number(receiptDetails.amount)) &&
    Number(receiptDetails.amount) < downpaymentAmount
  );
  const isWarningReceipt = Boolean(receiptDetails) && (!receiptVerified || receiptValidationErrors.length > 0);
  const manualAmount = Number(bookingData.payment.manualAmount || 0);
  const renderReceiptFeedback = () => {
    if (manualReviewAllowedReceipt) {
      return (
        <div role="status" style={{ padding: '1rem', borderRadius: 'var(--admin-radius-sm)', background: 'rgba(245, 158, 11, 0.08)', color: 'var(--status-warning)', fontSize: '.82rem', lineHeight: 1.5 }}>
          We couldn’t read this receipt automatically. It’s saved for staff review, and you may continue with your booking.
        </div>
      );
    }
    if (receiptVerified) {
      return (
        <div role="status" style={{ padding: '1rem', borderRadius: 'var(--admin-radius-sm)', background: 'rgba(var(--admin-success-rgb), 0.08)', color: 'var(--admin-success)', fontSize: '.82rem', fontWeight: '800', lineHeight: 1.5 }}>
          Receipt verified: ₱{Number(receiptDetails.amount || 0).toLocaleString()} received on {receiptDetails.date}.
        </div>
      );
    }
    return (
      <div role="alert" style={{ padding: '1rem', borderRadius: 'var(--admin-radius-sm)', background: 'rgba(239, 68, 68, 0.07)', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
        <strong style={{ color: 'var(--status-danger)', fontSize: '.82rem' }}>
          {receiptValidationErrors.length > 1 ? 'We found a few issues with this receipt' : 'We couldn’t verify this receipt'}
        </strong>
        <ul style={{ margin: '.45rem 0 0', paddingLeft: '1.2rem', color: 'var(--status-danger)', fontSize: '.76rem', lineHeight: 1.55 }}>
          {receiptValidationErrors.map((error, index) => <li key={error.code || index}>{error.message}</li>)}
        </ul>
      </div>
    );
  };
  const helpTips = [
    {
      title: 'Use a clear photo',
      text: 'Take a straight, well-lit shot of the full receipt. Blurry or angled images often miss the amount, reference, or recipient.'
    },
    {
      title: 'Check the payment amount',
      text: 'The receipt must show at least the required downpayment/full amount. Small mismatches can trigger a failed match.'
    },
    {
      title: 'Confirm the recipient name',
      text: 'The payee name must match the shop account shown in the QR section. A different recipient name will fail verification.'
    },
    {
      title: 'Use the current date',
      text: 'Receipts dated outside the accepted window (today or yesterday in Philippine time) are rejected.'
    },
    {
      title: 'Retry with the correct payment reference',
      text: 'Make sure the reference number is readable and matches the transfer you made. Cropped or hidden references often fail.'
    }
  ];

  const describeOcrFailure = (error) => {
    const raw = String(error?.message || error || '');
    if (/column .*ocr_metadata.* does not exist|image hash|duplicate/i.test(raw)) {
      return 'We could not verify this receipt because the verification service is temporarily unavailable. Please try again in a moment or contact support.';
    }
    if (/rate limit|too many receipt scans|wait \d+ second/i.test(raw)) {
      return 'Too many receipt scans were sent in a short time. Please wait a moment and try again.';
    }
    if (/too large|file too large|413|image is too large/i.test(raw)) {
      return 'That receipt image is too large. Please upload a smaller, clearer photo.';
    }
    if (/not recognized|invalid receipt|could not confirm this image is a payment receipt/i.test(raw)) {
      return 'We could not confirm this is a valid payment receipt. Please upload a clearer image of the receipt.';
    }
    return 'We could not verify this receipt right now. Please try again or contact support.';
  };

  const openReceiptInput = () => {
    setShowHelpTips(false);
    const input = document.getElementById('receipt-upload');
    if (input) {
      input.click();
    }
  };

  const adminRefNumberValid = adminDigitalMode === 'reference' ? Boolean(manualRefInput.trim().length >= 4) : true;
  const adminOcrProofValid = adminDigitalMode === 'ocr' ? Boolean(bookingData.payment?.proofOfPayment !== null && !isUploading) : true;

  const adminPaymentValid = !adminMode || (
    ['Downpayment', 'Full', 'Manual'].includes(bookingData.payment.type) &&
    (bookingData.payment.type !== 'Manual' || (manualAmount > 0 && manualAmount <= grandTotal)) &&
    (!isGcash || (adminDigitalMode === 'reference' ? adminRefNumberValid : adminOcrProofValid))
  );
  // 🛡️ SC-22 — PREREQUISITE GATE.
  // A dependent add-on (e.g. "Waxx Add-on") requires a wash on the same vehicle.
  // A stale tab or a manipulated payload could strip the prerequisite while
  // keeping the add-on; this blocks the submit and explains the fix. The SAME
  // check runs at the write boundary in bookingService.createBooking().
  const requirementCheck = validateServiceRequirements(vehicles);
  const requirementMessage = describeServiceRequirementViolation(requirementCheck.violations);

  // A manual-review pass skips the mismatch guards (there is nothing to compare
  // against) but still requires a receipt file to be attached.
  const isValid = requirementCheck.ok && (adminMode || termsAccepted) && !isUnderpaidReceipt && adminPaymentValid && (
    adminMode || !isGcash || (receiptVerified && bookingData.payment.proofOfPayment !== null && !isUploading)
  ) && (
    manualReviewAllowedReceipt || (!receiptDetails?.isDuplicate && !isNameMismatch && !isReceiptRejected)
  );

  const handleConfirmSubmit = () => {
    if (confirmInFlight.current || isSubmitting || isUnderpaidReceipt) return;
    confirmInFlight.current = true;
    setShowConfirm(false);
    onSubmit();
  };

  // Release the local submit lock once the parent finishes a submission attempt
  // (success OR failure), so a retry after a validation error is never blocked.
  useEffect(() => {
    if (!isSubmitting) confirmInFlight.current = false;
  }, [isSubmitting]);

  // Business Logic Constants
  const CASH_DISABLED_THRESHOLD = 1000;
  const canUseCash = adminMode || grandTotal < CASH_DISABLED_THRESHOLD;
  const canUseDownpayment = requiresDownpayment(grandTotal);

  // Auto-switch if current selection becomes invalid
  useEffect(() => {
    if (!adminMode && grandTotal >= CASH_DISABLED_THRESHOLD && bookingData.payment.method === 'Cash') {
      setBookingData(prev => ({ ...prev, payment: { ...prev.payment, method: 'GCash' } }));
    }
    if (!requiresDownpayment(grandTotal) && bookingData.payment.type === 'Downpayment') {
      setBookingData(prev => ({ ...prev, payment: { ...prev.payment, type: 'Full' } }));
    }
  }, [grandTotal]); // eslint-disable-line

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <style>{`
        .review-payment-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          gap: 1.5rem;
          align-items: start;
        }
        .review-action-footer {
          display: flex;
          justify-content: flex-end;
          flex-wrap: wrap;
          gap: 1rem;
        }
        .review-action-footer button {
          flex: 1 1 180px;
          min-width: 0;
        }
        .receipt-amount-summary {
          display: grid;
          grid-template-columns: 1fr;
          gap: 1rem;
          align-items: start;
        }
        @media (min-width: 900px) {
          .review-payment-grid {
            grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
            gap: 2rem;
          }
          .review-action-footer button {
            flex: 0 1 auto;
          }
        }
        @media (min-width: 700px) {
          .receipt-amount-summary {
            grid-template-columns: repeat(3, minmax(0, 1fr));
          }
        }
      `}</style>

      {/* Header */}
      <div>
        <h2 style={{ margin: '0 0 0.5rem 0', fontSize: '1.5rem', fontWeight: '950', color: 'var(--admin-text-primary)' }}>Review & Payment</h2>
        <p style={{ margin: 0, color: 'var(--admin-text-secondary)', fontSize: '0.9rem', fontWeight: '600' }}>
          {adminMode ? 'Please review the booking details and select a payment method.' : 'Please review the booking details and select the preferred payment method to secure the slot.'}
        </p>
      </div>

      <div className="review-payment-grid">

        {/* Left Column: Master Summary */}
        <div style={{ background: 'var(--admin-bg)', padding: '1.5rem', borderRadius: 'var(--admin-radius-lg)', border: '1px solid var(--admin-border)' }}>
          <h3 style={{ margin: '0 0 1rem 0', fontSize: '1.1rem', fontWeight: '900', color: 'var(--admin-text-primary)', textTransform: 'uppercase' }}>Booking Summary</h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--admin-border)', paddingBottom: '0.75rem' }}>
              <span style={{ color: 'var(--admin-text-secondary)', fontWeight: '600', fontSize: '0.85rem' }}>Schedule</span>
              <span style={{ color: 'var(--admin-text-primary)', fontWeight: '900', fontSize: '0.85rem', textAlign: 'right' }}>
                {bookingData.date} <br /> {bookingData.time}
              </span>
            </div>

            {vehicles.map((v, idx) => {
              // A package is a whole-vehicle flat price. Match the vehicle to the
              // package the pricing summary resolved for it (by type) so the
              // breakdown shows "Includes …" instead of itemised prices that no
              // longer reflect what is charged.
              const vehiclePackage = (promoSummary.appliedPackages || []).find(
                (entry) => String(entry.vehicleType || '').toLowerCase() === String(v.type || '').toLowerCase()
              ) || null;
              return (
              <div key={v.id} style={{ borderBottom: idx === vehicles.length - 1 ? 'none' : '1px solid var(--admin-border)', paddingBottom: '1rem' }}>
                {vehiclePackage && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem', marginBottom: '.4rem', color: 'var(--admin-brand)', fontSize: '.68rem', fontWeight: '900', textTransform: 'uppercase' }}>
                    <PackageIcon size={13} /> {vehiclePackage.name} · fixed package price
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <span style={{ color: 'var(--admin-text-secondary)', fontWeight: '900', fontSize: '0.75rem', textTransform: 'uppercase' }}>Vehicle {idx + 1}</span>
                  <span style={{ color: 'var(--admin-text-primary)', fontWeight: '900', fontSize: '0.85rem', textAlign: 'right' }}>
                    {v.brand} {v.model} ({v.plateNumber})
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  {(v.services || []).map(s => (
                    <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                      <span style={{ color: 'var(--admin-text-primary)', fontWeight: '600' }}>• {s.name}{vehiclePackage ? ' (included)' : ''}</span>
                      {vehiclePackage ? (
                        <span style={{ color: 'var(--admin-text-secondary)', fontWeight: '700', textDecoration: 'line-through' }}>₱{Number(s.original_price || s.price || 0).toLocaleString()}</span>
                      ) : (
                        <span style={{ color: 'var(--admin-text-primary)', fontWeight: '800' }}>₱{Number(s.price_at_booking ?? s.price ?? 0).toLocaleString()}</span>
                      )}
                    </div>
                  ))}
                  {vehiclePackage && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginTop: '.2rem', paddingTop: '.35rem', borderTop: '1px dashed var(--admin-border)' }}>
                      <span style={{ color: 'var(--admin-brand)', fontWeight: '900', textTransform: 'uppercase', fontSize: '.7rem' }}>Package price</span>
                      <span style={{ color: 'var(--admin-brand)', fontWeight: '900' }}>₱{Number(vehiclePackage.packagePrice || 0).toLocaleString()}</span>
                    </div>
                  )}
                </div>
              </div>
              );
            })}

            {promoSummary.totalDiscount > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '.35rem', paddingTop: '.85rem', borderTop: '1px solid var(--admin-border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.8rem' }}>
                  <span style={{ color: 'var(--admin-text-secondary)', fontWeight: '700' }}>Standalone subtotal</span>
                  <span style={{ color: 'var(--admin-text-secondary)', fontWeight: '800', textDecoration: 'line-through' }}>₱{promoSummary.originalTotal.toLocaleString()}</span>
                </div>
                {promoSummary.appliedPackages.map((entry) => (
                  <div key={entry.packageId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.8rem' }}>
                    <span style={{ color: 'var(--status-success)', fontWeight: '800' }}>{entry.name} savings</span>
                    <span style={{ color: 'var(--status-success)', fontWeight: '900' }}>−₱{entry.savings.toLocaleString()}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.8rem' }}>
                  <span style={{ color: 'var(--admin-text-secondary)', fontWeight: '700' }}>Total savings</span>
                  <span style={{ color: 'var(--status-success)', fontWeight: '900' }}>−₱{promoSummary.totalDiscount.toLocaleString()}</span>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '1rem', borderTop: '2px dashed var(--admin-border)' }}>
              <span style={{ color: 'var(--admin-text-primary)', fontWeight: '950', fontSize: '1.25rem', textTransform: 'uppercase' }}>Grand Total</span>
              <span style={{ color: 'var(--admin-brand)', fontWeight: '950', fontSize: '1.5rem' }}>₱{grandTotal.toLocaleString()}</span>
            </div>
          </div>
        </div>

        {/* Right Column: Payment Logic */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {adminMode && <div style={{ background: 'var(--admin-bg)', padding: '1rem', borderRadius: 'var(--admin-radius-md)', border: '1px solid var(--admin-border)', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* Payment Toggle */}
            <div>
              <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: '800', color: 'var(--admin-text-primary)', marginBottom: '0.75rem', textTransform: 'uppercase' }}>
                Payment Method
              </label>
              <div style={{ display: 'flex', gap: '1rem' }}>
                <button
                  onClick={() => setBookingData(prev => ({ ...prev, payment: { ...prev.payment, method: 'GCash' } }))}
                  style={{
                    flex: 1, padding: '1rem', borderRadius: 'var(--admin-radius-md)',
                    background: isGcash ? 'rgba(var(--admin-brand-rgb), 0.1)' : 'var(--admin-bg)',
                    border: `2px solid ${isGcash ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
                    color: isGcash ? 'var(--admin-brand)' : 'var(--admin-text-primary)',
                    fontWeight: '900', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', cursor: 'pointer', transition: 'all 0.2s'
                  }}
                >
                  <Wallet size={20} /> Digital Payment
                </button>
                <button
                  onClick={() => canUseCash && setBookingData(prev => ({ ...prev, payment: { ...prev.payment, method: 'Cash' } }))}
                  disabled={!canUseCash}
                  style={{
                    flex: 1, padding: '1rem', borderRadius: 'var(--admin-radius-md)',
                    background: !isGcash ? 'rgba(var(--admin-brand-rgb), 0.1)' : 'var(--admin-bg)',
                    border: `2px solid ${!isGcash ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
                    color: !isGcash ? 'var(--admin-brand)' : 'var(--admin-text-primary)',
                    fontWeight: '900', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                    cursor: canUseCash ? 'pointer' : 'not-allowed', transition: 'all 0.2s',
                    opacity: canUseCash ? 1 : 0.3, filter: canUseCash ? 'none' : 'grayscale(1)'
                  }}
                >
                  <Banknote size={20} /> Cash (On-Site)
                </button>
              </div>
              {!canUseCash && (
                <div style={{ fontSize: '0.65rem', color: 'var(--status-danger)', fontWeight: '800', marginTop: '0.5rem', textTransform: 'uppercase' }}>
                  * Cash option unavailable for bookings above ₱1,000
                </div>
              )}
            </div>

            {/* GCash Flow */}
            {adminMode && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '.65rem' }}>
                <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase' }}>Payment Amount</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '.5rem' }}>
                  {[
                    ['Downpayment', `Downpayment (₱${downpaymentAmount.toLocaleString()})`],
                    ['Full', `Full Payment (₱${grandTotal.toLocaleString()})`],
                    ['Manual', 'Manual Amount']
                  ].map(([value, label]) => <button key={value} type="button" disabled={value === 'Downpayment' && !canUseDownpayment} onClick={() => setBookingData(prev => ({ ...prev, payment: { ...prev.payment, type: value } }))} style={{ minHeight: '3rem', padding: '.65rem', background: bookingData.payment.type === value ? 'var(--admin-brand)' : 'var(--admin-card)', color: bookingData.payment.type === value ? '#fff' : 'var(--admin-text-primary)', border: `1px solid ${bookingData.payment.type === value ? 'var(--admin-brand)' : 'var(--admin-border)'}`, borderRadius: 'var(--admin-radius-sm)', fontWeight: '900', fontSize: '.72rem', cursor: value === 'Downpayment' && !canUseDownpayment ? 'not-allowed' : 'pointer', opacity: value === 'Downpayment' && !canUseDownpayment ? .4 : 1 }}>{label}</button>)}
                </div>
                {bookingData.payment.type === 'Manual' && <input type="text" inputMode="decimal" pattern="[0-9.]*" value={bookingData.payment.manualAmount || ''} onChange={event => setBookingData(prev => ({ ...prev, payment: { ...prev.payment, manualAmount: sanitizeCurrency(event.target.value) } }))} placeholder="Enter amount" aria-label="Manual payment amount" style={{ width: '100%', boxSizing: 'border-box', padding: '.85rem 1rem', background: 'var(--admin-input-bg)', color: 'var(--admin-text-primary)', border: '1px solid var(--admin-input-border)', borderRadius: '6px', fontWeight: '800' }} />}
                {bookingData.payment.type === 'Manual' && manualAmount > grandTotal && <span style={{ color: 'var(--status-danger)', fontSize: '.7rem', fontWeight: '800' }}>Manual amount cannot be higher than the booking total.</span>}
              </div>
            )}
            </div>}


            {/* Admin GCash: toggle OCR vs Reference Number */}
            {isGcash && adminMode && (
              <div style={{ background: 'var(--admin-bg)', padding: '1.5rem', borderRadius: 'var(--admin-radius-md)', border: '1px solid var(--admin-border)', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-text-secondary)', marginBottom: '0.75rem', textTransform: 'uppercase' }}>
                    Digital Payment Proof
                  </label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      type="button"
                      onClick={() => { setAdminDigitalMode('ocr'); setManualRefInput(''); setBookingData(prev => ({ ...prev, payment: { ...prev.payment, manualRefNumber: '' } })); }}
                      style={{
                        flex: 1, padding: '0.85rem 1rem', borderRadius: 'var(--admin-radius-sm)',
                        background: adminDigitalMode === 'ocr' ? 'var(--admin-brand)' : 'var(--admin-card)',
                        color: adminDigitalMode === 'ocr' ? '#fff' : 'var(--admin-text-secondary)',
                        border: `1px solid ${adminDigitalMode === 'ocr' ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
                        fontSize: '0.75rem', fontWeight: '950', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', transition: 'all 0.2s'
                      }}
                    >
                      <Camera size={15} /> Add Photo (OCR)
                    </button>
                    <button
                      type="button"
                      onClick={() => { setAdminDigitalMode('reference'); setReceiptDetails(null); setBookingData(prev => ({ ...prev, payment: { ...prev.payment, proofOfPayment: null, ocrData: null } })); }}
                      style={{
                        flex: 1, padding: '0.85rem 1rem', borderRadius: 'var(--admin-radius-sm)',
                        background: adminDigitalMode === 'reference' ? 'var(--admin-brand)' : 'var(--admin-card)',
                        color: adminDigitalMode === 'reference' ? '#fff' : 'var(--admin-text-secondary)',
                        border: `1px solid ${adminDigitalMode === 'reference' ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
                        fontSize: '0.75rem', fontWeight: '950', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', transition: 'all 0.2s'
                      }}
                    >
                      <Hash size={15} /> Input Reference No.
                    </button>
                  </div>
                </div>

                {adminDigitalMode === 'reference' ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <label style={{ fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase' }}>
                      Payment Reference Number
                    </label>
                    <input
                      type="text"
                      value={manualRefInput}
                      onChange={e => {
                        const cleaned = e.target.value.replace(/[^a-zA-Z0-9-]/g, '').toUpperCase();
                        setManualRefInput(cleaned);
                        setBookingData(prev => ({ ...prev, payment: { ...prev.payment, manualRefNumber: cleaned } }));
                      }}
                      placeholder="e.g. 1234-5678-9012"
                      maxLength={50}
                      style={{
                        width: '100%', boxSizing: 'border-box', padding: '0.85rem 1rem',
                        background: 'var(--admin-input-bg)', color: 'var(--admin-text-primary)',
                        border: `1px solid ${manualRefInput.length >= 4 ? 'var(--admin-brand)' : 'var(--admin-input-border)'}`,
                        borderRadius: '6px', fontWeight: '900', fontSize: '0.95rem', fontFamily: 'monospace', letterSpacing: '1px',
                        outline: 'none'
                      }}
                    />
                    <div style={{ fontSize: '0.65rem', color: 'var(--admin-text-secondary)', fontWeight: '700' }}>
                      Only letters (A–Z), numbers (0–9), and hyphens (-) are allowed. Minimum 4 characters.
                    </div>
                    {manualRefInput.length > 0 && manualRefInput.length < 4 && (
                      <div style={{ fontSize: '0.7rem', color: 'var(--status-danger)', fontWeight: '800' }}>
                        Reference number too short (minimum 4 characters).
                      </div>
                    )}
                    {manualRefInput.length >= 4 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: 'var(--admin-success)', fontWeight: '800' }}>
                        <CheckCircle2 size={13} /> Reference number accepted
                      </div>
                    )}
                  </div>
                ) : (
                  /* OCR mode: identical flow to customer */
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <input
                      type="file"
                      id="admin-receipt-upload"
                      accept="image/*"
                      onChange={handleFileUpload}
                      style={{ display: 'none' }}
                    />

                    {!receiptDetails ? (
                      <label
                        htmlFor="admin-receipt-upload"
                        className="admin-card-hover"
                        style={{
                          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem',
                          padding: '2.5rem 2rem', border: '2px dashed var(--admin-brand)', borderRadius: 'var(--admin-radius-lg)',
                          background: 'rgba(var(--admin-brand-rgb), 0.02)',
                          cursor: 'pointer', transition: 'all 0.3s ease'
                        }}
                      >
                        {isUploading ? (
                          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.5rem' }}>
                            <div style={{ position: 'relative', width: '60px', height: '60px' }}>
                              <div style={{ position: 'absolute', inset: 0, border: '4px solid rgba(var(--admin-brand-rgb), 0.1)', borderRadius: '50%' }} />
                              <div style={{ position: 'absolute', inset: 0, border: '4px solid var(--admin-brand)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                            </div>
                            <div>
                              <div style={{ color: 'var(--admin-brand)', fontWeight: '950', fontSize: '1rem', marginBottom: '0.5rem', letterSpacing: '1px' }}>⏳ Verifying receipt details...</div>
                              <div style={{ color: 'var(--admin-text-secondary)', fontSize: '0.7rem', fontWeight: '800', textTransform: 'uppercase' }}>{scanStep}</div>
                            </div>
                          </div>
                        ) : (
                          <>
                            <Upload size={36} color="var(--admin-brand)" />
                            <div style={{ textAlign: 'center' }}>
                              <div style={{ color: 'var(--admin-brand)', fontWeight: '950', fontSize: '1rem', letterSpacing: '1px' }}>UPLOAD PAYMENT RECEIPT</div>
                              <div style={{ color: 'var(--admin-text-secondary)', fontWeight: '800', fontSize: '0.7rem', marginTop: '0.4rem', textTransform: 'uppercase' }}>Supports E-Wallet & Bank Receipts</div>
                            </div>
                          </>
                        )}
                      </label>
                    ) : (
                      /* OCR RESULTS CARD — same as customer */
                      <div style={{
                        background: 'var(--admin-card)',
                        borderRadius: 'var(--admin-radius-lg)',
                        border: `1px solid ${isWarningReceipt ? 'var(--status-warning)' : 'var(--admin-success)'}`,
                        overflow: 'hidden',
                        animation: 'fadeIn 0.5s ease'
                      }}>
                        <div style={{
                          background: isWarningReceipt ? 'rgba(245, 158, 11, 0.1)' : 'rgba(var(--admin-success-rgb), 0.1)',
                          padding: '1.25rem',
                          borderBottom: `1px solid ${isWarningReceipt ? 'rgba(245, 158, 11, 0.2)' : 'rgba(var(--admin-success-rgb), 0.2)'}`,
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                            <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: isWarningReceipt ? 'var(--status-warning)' : 'var(--admin-success)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              {isWarningReceipt ? <AlertTriangle size={20} color="#fff" /> : <CheckCircle2 size={20} color="#fff" />}
                            </div>
                            <div>
                              <div style={{ color: isWarningReceipt ? (isDuplicateReceipt ? 'var(--status-danger)' : 'var(--status-warning)') : 'var(--admin-success)', fontWeight: '950', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '1px' }}>
                                {receiptStatusLabel}
                              </div>
                              <div style={{ color: 'var(--admin-text-secondary)', fontSize: '0.65rem', fontWeight: '800' }}>
                                {manualReviewAllowedReceipt ? 'STAFF WILL REVIEW YOUR UPLOAD' : (receiptVerified ? 'READY TO CONTINUE' : 'PLEASE CHECK THE MESSAGE BELOW')}
                              </div>
                            </div>
                          </div>
                        </div>

                        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                          {renderReceiptFeedback()}
                        </div>
                        <div style={{ display: 'flex', gap: '.75rem', padding: '1rem', borderTop: '1px solid var(--admin-border)', flexWrap: 'wrap' }}>
                          <button type="button" onClick={() => { setReceiptDetails(null); setBookingData(prev => ({ ...prev, payment: { ...prev.payment, proofOfPayment: null } })); }} style={{ flex: '1 1 190px', padding: '1rem', background: 'transparent', border: '1px solid var(--admin-border)', color: 'var(--admin-text-primary)', borderRadius: 'var(--admin-radius-sm)', fontSize: '.75rem', fontWeight: '950', cursor: 'pointer', textTransform: 'uppercase' }}>Upload Corrected Receipt</button>
                          <button type="button" onClick={() => setShowHelpTips(true)} style={{ flex: '1 1 190px', padding: '1rem', background: 'transparent', border: '1px solid var(--admin-border)', color: 'var(--admin-text-secondary)', borderRadius: 'var(--admin-radius-sm)', fontSize: '.75rem', fontWeight: '850', cursor: 'pointer', textTransform: 'uppercase' }}>OCR Tips</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {isGcash && !adminMode && (
              <div style={{ background: 'var(--admin-bg)', padding: '1.5rem', borderRadius: 'var(--admin-radius-md)', border: '1px solid var(--admin-border)', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

                {/* Payment Type Selection (Full vs Downpayment) */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-text-secondary)', marginBottom: '0.75rem', textTransform: 'uppercase' }}>
                    GCash Payment Type
                  </label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      onClick={() => setBookingData(prev => ({ ...prev, payment: { ...prev.payment, type: 'Full' } }))}
                      style={{
                        flex: 1, padding: '0.75rem', borderRadius: 'var(--admin-radius-sm)',
                        background: bookingData.payment.type === 'Full' ? 'var(--admin-brand)' : 'var(--admin-card)',
                        color: bookingData.payment.type === 'Full' ? '#fff' : 'var(--admin-text-primary)',
                        border: `1px solid ${bookingData.payment.type === 'Full' ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
                        fontSize: '0.8rem', fontWeight: '900', cursor: 'pointer', transition: '0.2s'
                      }}
                    >
                      Fully Pay (₱{grandTotal.toLocaleString()})
                    </button>
                    <button
                      onClick={() => canUseDownpayment && setBookingData(prev => ({ ...prev, payment: { ...prev.payment, type: 'Downpayment' } }))}
                      disabled={!canUseDownpayment}
                      style={{
                        flex: 1, padding: '0.75rem', borderRadius: 'var(--admin-radius-sm)',
                        background: bookingData.payment.type === 'Downpayment' ? 'var(--admin-brand)' : 'var(--admin-card)',
                        color: bookingData.payment.type === 'Downpayment' ? '#fff' : 'var(--admin-text-primary)',
                        border: `1px solid ${bookingData.payment.type === 'Downpayment' ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
                        fontSize: '0.8rem', fontWeight: '900', cursor: canUseDownpayment ? 'pointer' : 'not-allowed',
                        transition: '0.2s', opacity: canUseDownpayment ? 1 : 0.3
                      }}
                    >
                      Downpayment (₱{downpaymentAmount.toLocaleString()})
                    </button>
                  </div>
                  {!canUseDownpayment && (
                    <div style={{ fontSize: '0.65rem', color: 'var(--admin-text-secondary)', fontWeight: '700', marginTop: '0.5rem' }}>
                      * Downpayment only available for bookings above ₱1,000
                    </div>
                  )}
                </div>

                <div style={{ height: '1px', background: 'var(--admin-border)', margin: '0.5rem 0' }} />

                <div style={{ textAlign: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: '800', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>Scan to Pay</div>
                    <button type="button" onClick={() => setShowHelpTips(true)} style={{ padding: '0.45rem 0.8rem', background: 'transparent', border: '1px solid var(--admin-border)', color: 'var(--admin-text-secondary)', borderRadius: 'var(--admin-radius-sm)', fontSize: '0.62rem', fontWeight: '900', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '1px' }}>OCR Tips</button>
                  </div>
                  {settings.loaded ? (
                    <>
                      {qrTarget?.PAYMENT_QR_URL ? (
                        <QRMagnifier qrUrl={qrTarget.PAYMENT_QR_URL} accountName={qrTarget.QR_ACCOUNT_NAME} accountNumber={qrTarget.QR_ACCOUNT_NUMBER} />
                      ) : (
                        <div style={{ width: '100%', maxWidth: '400px', height: '550px', margin: '1.5rem auto', background: 'var(--admin-card)', border: '1px dashed var(--admin-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', borderRadius: 'var(--admin-radius-lg)' }}>No QR Configured</div>
                      )}
                      <div style={{ fontSize: '1.25rem', fontWeight: '950', color: 'var(--admin-text-primary)' }}>{qrTarget?.QR_ACCOUNT_NAME}</div>
                      <div style={{ fontSize: '1.15rem', fontWeight: '800', color: 'var(--admin-brand)', marginTop: '0.25rem' }}>{qrTarget?.QR_ACCOUNT_NUMBER}</div>
                    </>
                  ) : (
                    <div style={{ padding: '2rem', color: 'var(--admin-text-secondary)', fontSize: '0.85rem', fontWeight: '600' }}>Loading business settings...</div>
                  )}
                </div>

                <div style={{ background: 'rgba(var(--admin-info-rgb), 0.1)', border: '1px solid rgba(var(--admin-info-rgb), 0.2)', padding: '1.25rem', borderRadius: 'var(--admin-radius-md)', color: 'var(--admin-info)', display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
                  <ShieldAlert size={20} style={{ flexShrink: 0, marginTop: '2px' }} />
                  <span style={{ fontSize: '0.85rem', fontWeight: '600', lineHeight: 1.5 }}>
                    Please pay <strong>₱{(bookingData.payment.type === 'Full' ? grandTotal : downpaymentAmount).toLocaleString()}</strong> and upload the GCash receipt below.
                  </span>
                </div>

                {/* Receipt Upload & OCR Visualization */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <input
                    type="file"
                    id="receipt-upload"
                    accept="image/*"
                    onChange={handleFileUpload}
                    style={{ display: 'none' }}
                  />

                  {!receiptDetails ? (
                    <label
                      htmlFor="receipt-upload"
                      className="admin-card-hover"
                      style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem',
                        padding: '3rem 2rem', border: '2px dashed var(--admin-brand)', borderRadius: 'var(--admin-radius-lg)',
                        background: 'rgba(var(--admin-brand-rgb), 0.02)',
                        cursor: 'pointer', transition: 'all 0.3s ease'
                      }}
                    >
                      {isUploading ? (
                        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.5rem' }}>
                          <div style={{ position: 'relative', width: '60px', height: '60px' }}>
                            <div style={{ position: 'absolute', inset: 0, border: '4px solid rgba(var(--admin-brand-rgb), 0.1)', borderRadius: '50%' }} />
                            <div style={{ position: 'absolute', inset: 0, border: '4px solid var(--admin-brand)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                            <div style={{ position: 'absolute', inset: '10px', background: 'var(--admin-brand)', opacity: 0.1, borderRadius: '50%', animation: 'pulse 1.5s ease-in-out infinite' }} />
                          </div>
                          <div>
                            <div style={{ color: 'var(--admin-brand)', fontWeight: '950', fontSize: '1rem', marginBottom: '0.5rem', letterSpacing: '1px' }}>⏳ Verifying receipt details...</div>
                            <div style={{ color: 'var(--admin-text-secondary)', fontSize: '0.7rem', fontWeight: '800', textTransform: 'uppercase' }}>{scanStep}</div>
                          </div>
                        </div>
                      ) : (
                        <>
                          <Upload size={40} color="var(--admin-brand)" />
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ color: 'var(--admin-brand)', fontWeight: '950', fontSize: '1.1rem', letterSpacing: '1px' }}>UPLOAD PAYMENT RECEIPT</div>
                            <div style={{ color: 'var(--admin-text-secondary)', fontWeight: '800', fontSize: '0.75rem', marginTop: '0.5rem', textTransform: 'uppercase' }}>Supports E-Wallet & Bank Receipts</div>
                          </div>
                        </>
                      )}
                    </label>
                  ) : (
                    /* OCR RESULTS CARD (The Description View) */
                    <div style={{
                      background: 'var(--admin-card)',
                      borderRadius: 'var(--admin-radius-lg)',
                      border: `1px solid ${isWarningReceipt ? 'var(--status-warning)' : 'var(--admin-success)'}`,
                      overflow: 'hidden',
                      animation: 'fadeIn 0.5s ease'
                    }}>
                      {/* Header */}
                      <div style={{
                        background: isWarningReceipt ? 'rgba(245, 158, 11, 0.1)' : 'rgba(var(--admin-success-rgb), 0.1)',
                        padding: '1.25rem',
                        borderBottom: `1px solid ${isWarningReceipt ? 'rgba(245, 158, 11, 0.2)' : 'rgba(var(--admin-success-rgb), 0.2)'}`,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center'
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          <div style={{
                            width: '32px', height: '32px', borderRadius: '50%',
                            background: isWarningReceipt ? 'var(--status-warning)' : 'var(--admin-success)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center'
                          }}>
                            {isWarningReceipt ? <AlertTriangle size={20} color="#fff" /> : <CheckCircle2 size={20} color="#fff" />}
                          </div>
                          <div>
                            <div style={{ color: isWarningReceipt ? (isDuplicateReceipt ? 'var(--status-danger)' : 'var(--status-warning)') : 'var(--admin-success)', fontWeight: '950', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '1px' }}>
                              {receiptStatusLabel}
                            </div>
                            <div style={{ color: 'var(--admin-text-secondary)', fontSize: '0.65rem', fontWeight: '800' }}>
                              {manualReviewAllowedReceipt ? 'STAFF WILL REVIEW YOUR UPLOAD' : (receiptVerified ? 'READY TO CONTINUE' : 'PLEASE CHECK THE MESSAGE BELOW')}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

                        {renderReceiptFeedback()}

                      </div>
                      <div style={{ display: 'flex', gap: '.75rem', padding: '1rem', borderTop: '1px solid var(--admin-border)', flexWrap: 'wrap' }}>
                        <button type="button" onClick={() => { setReceiptDetails(null); setBookingData(prev => ({ ...prev, payment: { ...prev.payment, proofOfPayment: null } })); }} style={{ flex: '1 1 190px', padding: '1rem', background: 'transparent', border: '1px solid var(--admin-border)', color: 'var(--admin-text-primary)', borderRadius: 'var(--admin-radius-sm)', fontSize: '.75rem', fontWeight: '950', cursor: 'pointer', textTransform: 'uppercase' }}>Upload Corrected Receipt</button>
                        <button type="button" onClick={() => setShowHelpTips(true)} style={{ flex: '1 1 190px', padding: '1rem', background: 'transparent', border: '1px solid var(--admin-border)', color: 'var(--admin-text-secondary)', borderRadius: 'var(--admin-radius-sm)', fontSize: '.75rem', fontWeight: '850', cursor: 'pointer', textTransform: 'uppercase' }}>OCR Tips</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Cash Flow */}
            {!isGcash && (
              <div style={{ background: adminMode ? 'rgba(16, 185, 129, 0.1)' : 'rgba(var(--admin-warning-rgb), 0.1)', border: `1px solid ${adminMode ? 'rgba(16, 185, 129, 0.35)' : 'rgba(var(--admin-warning-rgb), 0.3)'}`, padding: '1.5rem', borderRadius: 'var(--admin-radius-md)', color: adminMode ? '#10b981' : 'var(--admin-warning)', display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
                <ShieldAlert size={24} style={{ flexShrink: 0, color: adminMode ? '#10b981' : 'var(--status-warning)' }} />
                <div>
                  <div style={{ fontSize: '1rem', fontWeight: '900', marginBottom: '0.5rem', color: adminMode ? '#10b981' : 'var(--status-warning)' }}>
                    {adminMode ? 'On-Site Cash Payment (Admin Walk-In)' : 'On-Site Cash Payment'}
                  </div>
                  <div style={{ fontSize: '0.85rem', fontWeight: '600', lineHeight: 1.5, color: adminMode ? 'var(--admin-text-primary)' : 'var(--status-warning)' }}>
                    {adminMode
                      ? 'The booking is being recorded directly by the admin and will be automatically CONFIRMED. Payment is recorded to the financial ledger immediately without entering payment verification.'
                      : 'By selecting Cash, your booking will be marked as PENDING. Your slot is not fully secured until you arrive at the shop. We recommend arriving 15 minutes early.'}
                  </div>
                </div>
              </div>
            )}
          </div>

          {!requirementCheck.ok && (
            <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.4)', padding: '1rem 1.25rem', borderRadius: 'var(--admin-radius-md)', color: 'var(--status-danger)', display: 'flex', gap: '0.75rem', alignItems: 'flex-start', marginBottom: '1rem' }}>
              <ShieldAlert size={20} style={{ flexShrink: 0, marginTop: '1px' }} />
              <div style={{ fontSize: '0.85rem', fontWeight: '700', lineHeight: 1.5 }}>
                {requirementMessage}
              </div>
            </div>
          )}

          {!adminMode && <div style={{ padding: '1rem', background: termsAccepted ? 'rgba(var(--admin-brand-rgb), 0.05)' : 'transparent', borderRadius: 'var(--admin-radius-md)', border: `1px solid ${termsAccepted ? 'var(--admin-brand)' : 'var(--admin-border)'}`, transition: 'all 0.2s' }}>
            <label style={{ display: 'flex', gap: '1rem', cursor: 'pointer', alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={(e) => setTermsAccepted(e.target.checked)}
                style={{ width: '20px', height: '20px', marginTop: '2px', cursor: 'pointer', accentColor: 'var(--admin-brand)' }}
              />
              <span style={{ fontSize: '0.85rem', color: 'var(--admin-text-primary)', fontWeight: '600', lineHeight: 1.4 }}>
                By clicking this box, you allow <strong>Comar Garage</strong> to have access to your personal information and agree to our <button type="button" onClick={() => setShowTermsModal(true)} style={{ border: 'none', background: 'transparent', color: 'var(--admin-brand)', fontWeight: 900, padding: 0, cursor: 'pointer', textDecoration: 'underline' }}>Terms and Conditions</button> for service and data privacy.
              </span>
            </label>
          </div>}

          {showTermsModal && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
              <div style={{ width: '100%', maxWidth: '620px', background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-lg)', boxShadow: '0 20px 45px rgba(0,0,0,0.3)', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.25rem', background: 'var(--admin-sidebar)', borderBottom: '1px solid var(--admin-border)' }}>
                  <h3 style={{ margin: 0, color: 'var(--admin-text-primary)', fontSize: '1rem', fontWeight: 950, textTransform: 'uppercase' }}>Terms & Conditions</h3>
                  <button type="button" onClick={() => setShowTermsModal(false)} style={{ border: 'none', background: 'transparent', color: 'var(--admin-text-secondary)', fontSize: '1.25rem', cursor: 'pointer' }}>×</button>
                </div>
                <div style={{ padding: '1.25rem', maxHeight: '70vh', overflowY: 'auto', color: 'var(--admin-text-primary)', fontSize: '0.9rem', lineHeight: 1.7 }}>
                  <p>1. Customer information provided during booking is collected solely for scheduling, service communication, and payment verification.</p>
                  <p>2. All bookings are subject to vehicle condition, available staff capacity, and service timing confirmation by the studio.</p>
                  <p>3. Deposits and payments remain subject to the studio’s refund and cancellation policy as disclosed in the booking confirmation.</p>
                  <p>4. Customers agree to provide truthful vehicle details and to keep the contact information current for appointment updates.</p>
                  <p>5. By submitting this booking, the customer authorizes the studio to process personal data required for service delivery, account management, and operational communications.</p>
                  <p>6. This placeholder agreement is subject to future legal review and may be updated without notice.</p>
                </div>
                <div style={{ padding: '1rem 1.25rem', borderTop: '1px solid var(--admin-border)', display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="button" onClick={() => setShowTermsModal(false)} style={{ padding: '0.75rem 1.25rem', background: 'var(--admin-brand)', border: 'none', borderRadius: 'var(--admin-radius-sm)', color: 'var(--admin-text-on-brand)', fontWeight: 900, cursor: 'pointer' }}>Close</button>
                </div>
              </div>
            </div>
          )}

          {showHelpTips && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
              <div style={{ width: '100%', maxWidth: '620px', background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-lg)', boxShadow: '0 20px 45px rgba(0,0,0,0.3)', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.25rem', background: 'var(--admin-sidebar)', borderBottom: '1px solid var(--admin-border)' }}>
                  <h3 style={{ margin: 0, color: 'var(--admin-text-primary)', fontSize: '1rem', fontWeight: 950, textTransform: 'uppercase' }}>OCR troubleshooting</h3>
                  <button type="button" onClick={() => setShowHelpTips(false)} style={{ border: 'none', background: 'transparent', color: 'var(--admin-text-secondary)', fontSize: '1.25rem', cursor: 'pointer' }}>×</button>
                </div>
                <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.9rem', maxHeight: '70vh', overflowY: 'auto' }}>
                  {helpTips.map((tip) => (
                    <div key={tip.title} style={{ padding: '0.9rem 1rem', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-md)', background: 'rgba(var(--admin-brand-rgb), 0.03)' }}>
                      <div style={{ fontSize: '0.76rem', fontWeight: 900, color: 'var(--admin-brand)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '0.35rem' }}>{tip.title}</div>
                      <div style={{ color: 'var(--admin-text-primary)', fontSize: '0.84rem', lineHeight: 1.5 }}>{tip.text}</div>
                    </div>
                  ))}
                </div>
                <div style={{ padding: '1rem 1.25rem', borderTop: '1px solid var(--admin-border)', display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => setShowHelpTips(false)} style={{ padding: '0.75rem 1.25rem', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-sm)', color: 'var(--admin-text-primary)', fontWeight: 900, cursor: 'pointer' }}>Close</button>
                  <button type="button" onClick={openReceiptInput} style={{ padding: '0.75rem 1.25rem', background: 'var(--admin-brand)', border: 'none', borderRadius: 'var(--admin-radius-sm)', color: 'var(--admin-text-on-brand)', fontWeight: 900, cursor: 'pointer' }}>Upload Corrected Receipt</button>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* Action Footer */}
      <div className="review-action-footer" style={{ borderTop: '1px solid var(--admin-border)', paddingTop: '1.5rem', marginTop: '1rem' }}>
        <button
          onClick={onBack}
          style={{
            padding: '1rem 2rem', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-md)', fontWeight: '950', fontSize: '1rem', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '1px'
          }}
        >
          Back
        </button>

        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            style={{
              background: 'transparent',
              border: '1px solid var(--status-danger)',
              color: 'var(--status-danger)',
              padding: '1rem 2rem',
              borderRadius: 'var(--admin-radius-md)',
              fontWeight: '950',
              cursor: 'pointer',
              textTransform: 'uppercase',
              letterSpacing: '1px'
            }}
          >
            Cancel Booking
          </button>
        )}
        <button
          onClick={() => {
            if (isUnderpaidReceipt) return;
            setShowConfirm(true);
          }}
          disabled={!isValid || isSubmitting}
          title={isReceiptBlocked ? 'Receipt must be verified before submitting.' : (isUploading ? 'Verifying receipt details...' : undefined)}
          style={{
            padding: '1rem 2rem',
            background: isValid ? 'var(--admin-brand)' : 'var(--admin-bg)',
            color: isValid ? '#fff' : 'var(--admin-text-secondary)',
            border: `1px solid ${isValid ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
            borderRadius: 'var(--admin-radius-md)',
            fontWeight: '950',
            fontSize: '1rem',
            cursor: isValid ? 'pointer' : 'not-allowed',
            opacity: isValid ? 1 : 0.65,
            textTransform: 'uppercase',
            letterSpacing: '1px',
            transition: 'all 0.3s ease'
          }}
        >
          {isSubmitting
            ? 'Submitting...'
            : (isUploading ? '⏳ Verifying receipt details...' : (isReceiptBlocked ? '⛔ Receipt Not Verified' : 'Submit Booking'))}
        </button>
      </div>

      {/* Confirmation Modal */}
      {showConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, backdropFilter: 'blur(10px)' }}>
          <div style={{ background: 'var(--admin-card)', padding: '2.5rem', borderRadius: 'var(--admin-radius-lg)', border: '1px solid var(--admin-border)', width: '100%', maxWidth: '450px', textAlign: 'center', boxShadow: '0 20px 50px rgba(0,0,0,0.5)' }}>
            <div style={{ width: '80px', height: '80px', borderRadius: '50%', background: 'rgba(var(--admin-brand-rgb), 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem auto' }}>
              <CheckCircle2 size={40} color="var(--admin-brand)" />
            </div>
            <h3 style={{ fontSize: '1.5rem', fontWeight: '950', color: 'var(--admin-text-primary)', margin: '0 0 1rem 0' }}>Confirm Booking?</h3>
            <p style={{ color: 'var(--admin-text-secondary)', fontSize: '0.95rem', fontWeight: '600', lineHeight: 1.6, margin: '0 0 2rem 0' }}>
              Are you sure you want to proceed with this booking? Please ensure all vehicle details and payment info are correct.
            </p>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <button
                onClick={() => !isSubmitting && setShowConfirm(false)}
                disabled={isSubmitting}
                style={{ flex: 1, padding: '1rem', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-md)', fontWeight: '900', color: 'var(--admin-text-primary)', cursor: isSubmitting ? 'not-allowed' : 'pointer', opacity: isSubmitting ? 0.5 : 1 }}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmSubmit}
                disabled={isSubmitting}
                style={{ flex: 1, padding: '1rem', background: 'var(--admin-brand)', border: 'none', borderRadius: 'var(--admin-radius-md)', fontWeight: '900', color: 'var(--admin-text-on-brand)', cursor: isSubmitting ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', opacity: isSubmitting ? 0.7 : 1 }}
              >
                {isSubmitting ? (
                  <>
                    <div className="spinner" style={{ width: '16px', height: '16px', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                    Submitting...
                  </>
                ) : 'Yes, Submit'}
              </button>
            </div>
          </div>
          <style>{`
            @keyframes spin { to { transform: rotate(360deg); } }
            @keyframes pulse {
              0% { transform: scale(0.95); opacity: 0.2; }
              50% { transform: scale(1.05); opacity: 0.5; }
              100% { transform: scale(0.95); opacity: 0.2; }
            }
            @keyframes fadeIn {
              from { opacity: 0; transform: translateY(10px); }
              to { opacity: 1; transform: translateY(0); }
            }
          `}</style>
        </div>
      )}

    </div>
  );
};

export default Step4ReviewPayment;
