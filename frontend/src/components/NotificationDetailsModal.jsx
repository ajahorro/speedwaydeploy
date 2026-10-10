import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, Info, Calendar, Star, Megaphone, Bell, MessageSquare } from 'lucide-react';
import toast from '@/lib/toast';
import { parseChatNotification } from './NotificationPopover';
import { supabase } from '../lib/supabase';
import { resolveBookingId, resolveStaffJobId } from '../utils/notificationRouting';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const TYPE_ICONS = {
  ANNOUNCEMENT: Megaphone,
  BOOKING_CREATED: Calendar,
  BOOKING_UPDATED: Calendar,
  BOOKING_CONFIRMED: Calendar,
  BOOKING_CANCELLED: Calendar,
  PAYMENT_SUBMITTED: Star,
  PAYMENT_VERIFIED: Star,
  MESSAGE_RECEIVED: MessageSquare,
  default: Info,
};

const getIcon = (type) => TYPE_ICONS[type] || TYPE_ICONS.default;

const NotificationDetailsModal = ({ notification, onClose, onMarkRead, profile }) => {
  const navigate = useNavigate();
  if (!notification) return null;
  const Icon = getIcon(notification.notification_type);
  const chatNotification = parseChatNotification(notification);

  // Determine correct role prefix for routing
  const role = profile?.role?.toUpperCase();
  const rolePrefix = role === 'ADMIN' ? '/admin' : role === 'STAFF' ? '/staff' : '/customer';

  const handleViewBooking = async (e) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }

    const actionBookingId = notification.action_url?.match(/\/bookings\/([A-Za-z0-9-]+)/)?.[1];
    const hashBookingId = notification.booking_id || notification.message?.match(/#([A-Za-z0-9_-]{8})/)?.[1] || actionBookingId;
    if (!hashBookingId) {
      toast.error('Associated booking record not found.');
      return;
    }

    try {
      if (role === 'STAFF') {
        const jobId = await resolveStaffJobId(supabase, hashBookingId);
        if (!jobId) {
          toast.error('No assigned vehicle was found for this booking.');
          return;
        }
        onClose();
        navigate(`/staff/job/${jobId}`);
        return;
      }

      const resolvedBookingId = await resolveBookingId(supabase, hashBookingId);
      if (!resolvedBookingId) {
        toast.error('Associated booking record not found.');
        return;
      }
      const targetUrl = `${rolePrefix}/bookings/${resolvedBookingId}${notification.notification_type === 'MESSAGE_RECEIVED' || notification.title?.toLowerCase().includes('new message') ? '?chat=open' : ''}`;
      onClose();
      navigate(targetUrl);
    } catch (error) {
      toast.error(`Could not open the associated booking: ${error.message || 'lookup failed.'}`);
    }
  };

  // Helper to highlight and parse booking references inside the message text
  const renderFormattedMessage = (message) => {
    if (!message) return '';
    const parts = message.split(/(#[A-Za-z0-9_-]+)/g);
    const hasBookingReference = parts.some(part => /^#[A-Za-z0-9_-]+$/.test(part));
    return parts.map((part, index) => {
      if (part.startsWith('#')) {
        if (notification.booking_id || hasBookingReference) {
          return (
            <span
              key={index}
              onClick={(e) => handleViewBooking(e)}
              style={{
                color: 'var(--admin-brand)',
                fontWeight: '950',
                cursor: 'pointer',
                textDecoration: 'underline',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '2px'
              }}
              title="Click to view booking details"
            >
              {part} <ExternalLink size={12} />
            </span>
          );
        }
        // If there is no associated booking, return as plain text with slight highlight
        return (
          <span key={index} style={{ color: 'var(--admin-brand)', fontWeight: '950' }}>
            {part}
          </span>
        );
      }
      return part;
    }).concat(notification.booking_id && !hasBookingReference ? [
      <span key="booking-reference" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', marginLeft: '0.35rem' }}>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          onClick={handleViewBooking}
          style={{ background: 'none', border: 'none', padding: 0, color: 'var(--admin-brand)', fontWeight: '950', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}
        >
          #{String(notification.booking_id).slice(0, 8).toUpperCase()}
          <ExternalLink size={12} style={{ verticalAlign: 'middle', marginLeft: '0.2rem' }} />
        </button>
      </span>
    ] : []);
  };

  const canViewBooking = Boolean(notification.booking_id || notification.message?.match(/#[A-Za-z0-9_-]{8}/));

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="ui-root max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
            <Icon className="size-4" aria-hidden="true" />
            {notification.notification_type || 'SYSTEM'}
          </p>
          <DialogTitle>{notification.title || 'Notification Details'}</DialogTitle>
          <DialogDescription>{new Date(notification.created_at).toLocaleString()}</DialogDescription>
        </DialogHeader>

        {/* Full message with clickable booking references. Chat notifications show who wrote it. */}
        {chatNotification?.sender && (
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
            <MessageSquare className="size-3.5" aria-hidden="true" />
            {chatNotification.sender}
          </p>
        )}
        <div className="break-words rounded-md border bg-muted/40 p-4 text-sm leading-relaxed">
          {renderFormattedMessage(chatNotification ? (chatNotification.body || 'Attachment') : notification.message)}
        </div>

        <DialogFooter>
          {canViewBooking && (
            <Button type="button" onClick={handleViewBooking}>View Booking <ExternalLink /></Button>
          )}
          {!notification.is_read && onMarkRead && (
            <Button type="button" variant="outline" onClick={() => { onMarkRead(notification.id); }}>Mark as Read</Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default NotificationDetailsModal;
