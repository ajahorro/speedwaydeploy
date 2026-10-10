import { useState } from 'react';
import { FileCheck2 } from 'lucide-react';
import toast from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { useImagePreview } from '@/context/ImagePreviewContext';
import { refundProofUrl } from '@/services/refundProofService';

/**
 * "Proof of refund" button for a refund row (in a ledger, a booking, or the Refund Hub). It opens the administrator's
 * proof in the same picture viewer that receipts use. Renders nothing when the refund has no proof (older refunds).
 */
export default function RefundProofButton({ proof, size = 'sm', className = '' }) {
  const { openImage } = useImagePreview();
  const [opening, setOpening] = useState(false);
  if (!proof?.storage_path) return null;

  const open = async (event) => {
    event?.stopPropagation?.();
    setOpening(true);
    try {
      const url = await refundProofUrl(proof.storage_path);
      openImage(url, { alt: 'Proof of refund', caption: proof.proof_reference ? `Proof of refund · Reference ${proof.proof_reference}` : 'Proof of refund · Cash' });
    } catch {
      toast.error('The proof of refund could not be opened. Please try again.');
    } finally {
      setOpening(false);
    }
  };

  return (
    <Button type="button" variant="outline" size={size} className={`text-xs uppercase ${className}`} onClick={open} disabled={opening} title="View proof of refund">
      <FileCheck2 /> Proof of refund
    </Button>
  );
}
