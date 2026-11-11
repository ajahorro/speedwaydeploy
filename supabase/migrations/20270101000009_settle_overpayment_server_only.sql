-- Only the server (when a booking completes) moves leftover excess to refunds; a signed-in customer could call it on any booking.
revoke execute on function public.settle_overpayment_on_completion(uuid) from public, anon, authenticated;
