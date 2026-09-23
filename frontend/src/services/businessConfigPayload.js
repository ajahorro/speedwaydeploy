export const isMissingColumnError = (error, columnName) => {
  if (!error || typeof error.message !== 'string') return false;
  return error.message.includes(`Could not find the '${columnName}' column of 'business_config'`);
};

export const buildBusinessConfigUpdatePayload = (form, {
  supportsFaqs = false,
  supportsCustomServices = false,
  supportsVehicleTypes = false,
  qrConfigComplete = false,
} = {}) => {
  const payload = {
    business_name: form.business_name,
    contact_number: form.contact_number,
    email_address: form.email_address,
    business_address: form.business_address,
    opening_hour: form.opening_hour,
    closing_hour: form.closing_hour,
    qr_account_name: form.qr_account_name,
    qr_account_number: form.qr_account_number,
    fallback_receiver_name: '',
    fallback_receiver_number: '',
    payment_qr_url: form.payment_qr_url || '',
    gcash_qr_url: form.payment_qr_url || '',
    qr_photo_url: form.payment_qr_url || '',
    qr_config_complete: qrConfigComplete,
    slots_per_hour: Number(form.slots_per_hour),
    max_vehicles_per_staff: Number(form.max_vehicles_per_staff),
    booking_lead_time_minutes: Number(form.booking_lead_time_minutes),
    max_advance_days: Number(form.max_advance_days),
    closed_weekdays: form.closed_weekdays || [],
    enforce_capacity: Boolean(form.enforce_capacity),
  };

  if (supportsCustomServices) {
    payload.custom_services = form.custom_services;
  }

  if (supportsVehicleTypes) {
    payload.vehicle_types = form.vehicle_types || [];
  }

  if (supportsFaqs) {
    payload.faqs = form.faqs;
  }

  return payload;
};

export const stripUnsupportedBusinessConfigColumns = (payload, error) => {
  const unsupported = [];
  if (isMissingColumnError(error, 'custom_services')) unsupported.push('custom_services');
  if (isMissingColumnError(error, 'vehicle_types')) unsupported.push('vehicle_types');
  if (isMissingColumnError(error, 'faqs')) unsupported.push('faqs');

  if (unsupported.length === 0) return payload;

  const next = { ...payload };
  unsupported.forEach((key) => delete next[key]);
  return next;
};
