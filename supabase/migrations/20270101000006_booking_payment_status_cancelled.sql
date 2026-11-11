-- A cancelled booking's payment status reads "cancelled".
alter type public.booking_payment_status add value if not exists 'cancelled';
