import { supabase } from '../lib/supabase';

/**
 * Booking drafts: what a person has typed into the booking wizard, kept until
 * the booking is submitted or they press Cancel.
 *
 * Two copies, one rule: the browser copy (localStorage) is written on every
 * change so a reload never loses anything, and the server copy (booking_drafts)
 * follows a moment later so the draft also survives a different device or a
 * cleared browser. On load the newer of the two wins.
 *
 * What is NOT stored: the uploaded receipt file and its OCR result (a file cannot
 * be serialised, and a scan only means something next to its file).
 */

const DRAFT_VERSION = 1;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const localKey = (userId, kind) => `comar-booking-draft:${userId}:${kind}`;

/** The part of the wizard state worth keeping. */
export const toDraftData = (bookingData) => {
  const { payment, isRebooking, ...rest } = bookingData || {};
  return {
    ...rest,
    payment: payment ? { method: payment.method, type: payment.type, manualAmount: payment.manualAmount } : undefined
  };
};

/** True when there is something worth saving (an empty wizard is not a draft). */
export const hasMeaningfulDraft = (data) => {
  if (!data) return false;
  const vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
  return Boolean(
    data.date || data.time || (data.notes || '').trim() || (data.customerEmail || '').trim() ||
    data.fleetGroupId || data.adminCustomerReady ||
    vehicles.some((v) => v?.manual || v?.garageVehicleId || v?.fleetGroupId || v?.type ||
      (v?.brand || '').trim() || (v?.model || '').trim() || (v?.plateNumber || '').trim() || v?.services?.length)
  );
};

const readLocal = (userId, kind) => {
  try {
    const parsed = JSON.parse(localStorage.getItem(localKey(userId, kind)) || 'null');
    return parsed && parsed.v === DRAFT_VERSION ? parsed : null;
  } catch {
    return null;
  }
};

export const writeLocalDraft = (userId, kind, { data, step, extras }) => {
  try {
    localStorage.setItem(localKey(userId, kind), JSON.stringify({
      v: DRAFT_VERSION, data, step, extras: extras || null, updatedAt: new Date().toISOString()
    }));
  } catch { /* storage full or unavailable: the server copy still exists */ }
};

export const saveServerDraft = async (userId, kind, { data, step, extras }) => {
  const { error } = await supabase.from('booking_drafts').upsert({
    user_id: userId,
    kind,
    step,
    data: { ...data, __extras: extras || null }
  }, { onConflict: 'user_id,kind' });
  if (error) console.warn('[booking draft] could not save to the server:', error.message);
};

/** Remove the draft everywhere (submit or Cancel). */
export const deleteDraft = async (userId, kind) => {
  try { localStorage.removeItem(localKey(userId, kind)); } catch { /* ignore */ }
  const { error } = await supabase.from('booking_drafts').delete().eq('user_id', userId).eq('kind', kind);
  if (error) console.warn('[booking draft] could not delete the server copy:', error.message);
};

/** Load the newest draft (browser copy or server copy), or null. */
export const loadDraft = async (userId, kind) => {
  const local = readLocal(userId, kind);
  let server = null;
  try {
    const { data } = await supabase
      .from('booking_drafts')
      .select('step, data, updated_at')
      .eq('user_id', userId)
      .eq('kind', kind)
      .maybeSingle();
    if (data) {
      const { __extras, ...rest } = data.data || {};
      server = { data: rest, step: data.step, extras: __extras || null, updatedAt: data.updated_at };
    }
  } catch { /* offline: use the browser copy */ }

  const candidates = [local, server].filter(Boolean)
    .filter((d) => Date.now() - new Date(d.updatedAt).getTime() < MAX_AGE_MS)
    .filter((d) => hasMeaningfulDraft(d.data));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
};
