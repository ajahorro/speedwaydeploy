import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Building, Clock, Wrench, Tag, Save, AlertCircle, CheckCircle,
  Plus, X, Trash2, ArchiveRestore, CalendarClock
} from 'lucide-react';
import { useConfig } from '../../context/ConfigContext';
import { supabase } from '../../lib/supabase';
import PromoManager from '../../components/AdminSchedule/PromoManager';
import QrChangeOtpModal from '../../components/Business/QrChangeOtpModal';
import { validateQrRecipients } from '../../services/qrSecurityService';
import { sanitizeAlphaNum } from '../../config/constants';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import LeaveGuardModal from '../../components/LeaveGuardModal';

const TAB_KEYS = ['profile', 'hours', 'schedule', 'services', 'promos'];

// The fields each section owns (mirrors handleSaveSection's UPDATE payload).
const SECTION_FIELDS = {
  profile: [
    'business_name', 'contact_number', 'email_address', 'business_address',
    // Task B: the four MANDATORY QR recipient fields.
    'qr_account_name', 'qr_account_number', 'fallback_receiver_name', 'fallback_receiver_number',
  ],
  hours: ['opening_hour', 'closing_hour', 'slots_per_hour', 'max_vehicles_per_staff'],
  schedule: ['booking_lead_time_minutes', 'max_advance_days', 'closed_weekdays', 'enforce_capacity'],
  services: ['custom_services']
};

// JS weekday order (0=Sun..6=Sat) — matches Date.getDay() and the
// closed_weekdays int[] column added in migration 20260925000001.
const WEEKDAYS = [
  { value: 0, short: 'Sun', long: 'Sunday' },
  { value: 1, short: 'Mon', long: 'Monday' },
  { value: 2, short: 'Tue', long: 'Tuesday' },
  { value: 3, short: 'Wed', long: 'Wednesday' },
  { value: 4, short: 'Thu', long: 'Thursday' },
  { value: 5, short: 'Fri', long: 'Friday' },
  { value: 6, short: 'Sat', long: 'Saturday' }
];

const EMPTY_NEW_SERVICE = { name: '', price: '', description: '', durationMinutes: '60' };

// ---- Shared presentation (matches the admin theme's inline-style pattern) ----
const cardStyle = {
  background: 'var(--admin-card)',
  border: '1px solid var(--admin-border)',
  borderRadius: 'var(--admin-radius)',
  padding: '1.75rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '1.25rem',
  boxShadow: 'var(--admin-card-shadow)',
  color: 'var(--admin-text-primary)'
};

const insetPanelStyle = {
  background: 'var(--admin-bg)',
  border: '1px solid var(--admin-border)',
  borderRadius: 'var(--admin-radius-sm)',
  padding: '1rem'
};

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  gap: '1rem'
};

const inputStyle = {
  width: '100%',
  minWidth: 0,
  padding: '0.7rem 0.9rem',
  background: 'var(--admin-input-bg, var(--admin-bg))',
  border: '1px solid var(--admin-input-border, var(--admin-border))',
  borderRadius: 'var(--admin-radius-sm)',
  color: 'var(--admin-text-primary)',
  fontSize: '0.85rem',
  fontWeight: 700,
  outline: 'none',
  transition: 'border-color 0.2s, box-shadow 0.2s'
};

const labelStyle = {
  display: 'block',
  fontSize: '0.62rem',
  fontWeight: 950,
  color: 'var(--admin-text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '1px',
  marginBottom: '0.4rem'
};

const buttonBase = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  padding: '0.7rem 1.25rem',
  borderRadius: 'var(--admin-radius-sm)',
  fontSize: '0.74rem',
  fontWeight: 950,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  transition: 'all 0.2s'
};

const ghostButton = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.35rem',
  padding: '0.45rem 0.8rem',
  background: 'transparent',
  border: '1px solid var(--admin-border)',
  borderRadius: 'var(--admin-radius-sm)',
  color: 'var(--admin-text-primary)',
  fontSize: '0.68rem',
  fontWeight: 900,
  cursor: 'pointer'
};

const SectionHeading = ({ children, style }) => (
 <h2 style={{ margin: 0, fontSize: '0.85rem', fontWeight: 950, color: 'var(--admin-text-primary)', textTransform: 'uppercase', letterSpacing: '1px', borderBottom: '1px solid var(--admin-border)', paddingBottom: '0.75rem', ...style }}>
    {children}
 </h2>
);

const Field = ({ label, required, children }) => (
 <div>
    <label style={labelStyle}>
      {label}{required ? <span style={{ color: 'var(--admin-brand)' }}> *</span> : null}
    </label>
    {children}
 </div>
);

const Hint = ({ children }) => (
 <p style={{ margin: 0, fontSize: '0.7rem', fontWeight: 700, color: 'var(--status-warning, #f59e0b)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
    <AlertCircle size={13} /> {children}
 </p>
);

// Smart save button: grey + disabled until the section is dirty AND valid,
// then Speedway-red. Locks (and shows progress) while a save is in flight.
const SaveBar = ({ canSave, saving, dirty, label }) => {
  const active = canSave;
  const disabled = !active;
  const statusText = saving
    ? 'Saving changes...'
    : dirty
      ? 'Unsaved changes'
      : 'No changes to save';

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '1rem', paddingTop: '0.5rem', borderTop: '1px solid var(--admin-border)', flexWrap: 'wrap' }}>
      <span style={{ fontSize: '0.68rem', fontWeight: 800, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        {statusText}
      </span>
      <button
        type="submit"
        disabled={disabled}
        aria-disabled={disabled}
        style={{
          ...buttonBase,
          background: active ? 'var(--admin-brand)' : 'var(--admin-input-bg, var(--admin-bg))',
          color: active ? '#fff' : 'var(--admin-text-secondary)',
          border: `1px solid ${active ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
          cursor: active ? 'pointer' : 'not-allowed',
          opacity: active ? 1 : 0.65
        }}
      >
        <Save size={15} />
        <span>{saving ? 'Saving changes...' : label}</span>
      </button>
    </div>
  );
};

export default function BusinessHub() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Derive the active tab directly from the URL on every render so browser
  // Back/Forward navigation stays in sync. Fall back to 'profile' for any
  // unrecognized/absent ?tab= value instead of rendering an empty panel.
  const requestedTab = searchParams.get('tab');
  const currentTab = TAB_KEYS.includes(requestedTab) ? requestedTab : 'profile';

  const { refreshConfig } = useConfig();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });

  // Service catalog management state (Tab 3)
  const [newService, setNewService] = useState(EMPTY_NEW_SERVICE);
  const [editingServiceId, setEditingServiceId] = useState(null);
  const [showArchived, setShowArchived] = useState(false);

  // Live form state + a pristine snapshot used for dirty detection.
  const [businessForm, setBusinessForm] = useState({
    business_name: '',
    contact_number: '',
    email_address: '',
    business_address: '',
    opening_hour: '',
    closing_hour: '',
    // Task B: QR recipient fields replace the legacy single-payment pair.
    qr_account_name: '',
    qr_account_number: '',
    fallback_receiver_name: '',
    fallback_receiver_number: '',
    qr_config_version: 1,
    qr_config_complete: false,
    slots_per_hour: 2,
    max_vehicles_per_staff: 1,
    booking_lead_time_minutes: 120,
    max_advance_days: 30,
    closed_weekdays: [],
    enforce_capacity: true,
    custom_services: []
  });
  const [pristine, setPristine] = useState(null);
  const [recordId, setRecordId] = useState(null);
  // Task B: the QR change modal owns its own OTP flow. Saving the profile does
  // NOT commit QR changes — those go through the verified [Change QR] path only.
  const [showQrModal, setShowQrModal] = useState(false);

  useEffect(() => {
    fetchBusinessConfig();
  }, []);

  const fetchBusinessConfig = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('business_config')
        .select('*')
        .maybeSingle();

      if (error) throw error;
      if (data) {
        const merged = {
          business_name: data.business_name || '',
          contact_number: data.contact_number || '',
          email_address: data.email_address || '',
          business_address: data.business_address || '',
          opening_hour: data.opening_hour || '',
          closing_hour: data.closing_hour || '',
          qr_account_name: data.qr_account_name || '',
          qr_account_number: data.qr_account_number || '',
          fallback_receiver_name: data.fallback_receiver_name || '',
          fallback_receiver_number: data.fallback_receiver_number || '',
          qr_config_version: data.qr_config_version ?? 1,
          qr_config_complete: data.qr_config_complete === true,
          slots_per_hour: data.slots_per_hour ?? 2,
          max_vehicles_per_staff: data.max_vehicles_per_staff ?? 1,
          booking_lead_time_minutes: data.booking_lead_time_minutes ?? 120,
          max_advance_days: data.max_advance_days ?? 30,
          closed_weekdays: Array.isArray(data.closed_weekdays) ? data.closed_weekdays : [],
          enforce_capacity: data.enforce_capacity !== false,
          custom_services: Array.isArray(data.custom_services) ? data.custom_services : []
        };
        setBusinessForm(merged);
        setPristine(merged);
        setRecordId(data.id);
      } else {
        // No row yet — treat the initial defaults as pristine.
        setPristine((prev) => prev ?? businessForm);
      }
    } catch (err) {
      console.error('Failed to load business config:', err);
      setMessage({ type: 'error', text: 'Failed to load business configuration.' });
    } finally {
      setLoading(false);
    }
  };

  // Task B: block tab switches / navigation while a section has unsaved edits.
  const anyDirty = ['profile', 'hours', 'schedule', 'services'].some((s) => isDirty(s));
  const leaveGuard = useUnsavedChangesGuard(anyDirty);

  const handleTabChange = (tabKey) => {
    // Guard the in-app navigation; only switch when the guard approves.
    leaveGuard.confirmNavigation(() => setSearchParams({ tab: tabKey }));
  };

  const handleInputChange = (field, value) => {
    // Task B: strict alphanumeric guard on every free-text config field. Numeric
    // and boolean fields bypass it (they are parsed separately below).
    const TEXT_FIELDS = [
      'business_name', 'contact_number', 'email_address', 'business_address',
      'qr_account_name', 'qr_account_number', 'fallback_receiver_name', 'fallback_receiver_number',
    ];
    const nextValue = TEXT_FIELDS.includes(field) ? sanitizeAlphaNum(value) : value;
    setBusinessForm((prev) => ({ ...prev, [field]: nextValue }));
    setMessage((prev) => (prev.text ? { type: '', text: '' } : prev));
  };

  // Toggle a weekday in/out of the closed_weekdays array (kept sorted for a
  // stable dirty comparison).
  const toggleClosedWeekday = (day) => {
    setBusinessForm((prev) => {
      const current = prev.closed_weekdays || [];
      const next = current.includes(day)
        ? current.filter((d) => d !== day)
        : [...current, day].sort((a, b) => a - b);
      return { ...prev, closed_weekdays: next };
    });
    setMessage((prev) => (prev.text ? { type: '', text: '' } : prev));
  };

  // ---- Dirty / validity helpers ----
  const isDirty = (section) => {
    if (!pristine) return false;
    const fields = SECTION_FIELDS[section];
    return fields.some((f) => JSON.stringify(businessForm[f]) !== JSON.stringify(pristine[f]));
  };

  const sectionValid = (section) => {
    if (section === 'profile') {
      // Task B: profile requires a business name AND a complete QR recipient set.
      const qr = validateQrRecipients(businessForm);
      return Boolean(String(businessForm.business_name || '').trim()) && qr.ok;
    }
    if (section === 'hours') {
      const slots = Number(businessForm.slots_per_hour);
      const maxUnits = Number(businessForm.max_vehicles_per_staff);
      const opening = String(businessForm.opening_hour || '').trim();
      const closing = String(businessForm.closing_hour || '').trim();
      return opening.length > 0 && closing.length > 0 && slots >= 1 && maxUnits >= 1;
    }
    if (section === 'schedule') {
      // Mirror the DB CHECK constraints from migration 20260925000001 so an
      // invalid value can never be saved: lead time 0..43200, advance 1..365,
      // every closed weekday within 0..6.
      const lead = Number(businessForm.booking_lead_time_minutes);
      const advance = Number(businessForm.max_advance_days);
      const weekdaysValid = (businessForm.closed_weekdays || []).every(
        (d) => Number.isInteger(d) && d >= 0 && d <= 6
      );
      return (
        Number.isFinite(lead) && lead >= 0 && lead <= 43200 &&
        Number.isFinite(advance) && advance >= 1 && advance <= 365 &&
        weekdaysValid
      );
    }
    if (section === 'services') {
      // Valid so long as no in-progress editor has a blank name.
      return !(newService.name.trim() === '' && (newService.price !== '' || newService.description !== ''));
    }
    return true;
  };

  const canSave = (section) => !saving && isDirty(section) && sectionValid(section);

  // Targeted update on the existing row ID. We deliberately never include
  // promo_rules here, so saving profile/hours/services can never clobber a
  // concurrent promo change with stale state (PromoManager owns promo_rules).
  const handleSaveSection = async (e) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setMessage({ type: '', text: '' });

    try {
      // Resolve the existing row ID; without it there is nothing to update.
      let id = recordId;
      if (!id) {
        const { data: existing, error: fetchError } = await supabase
          .from('business_config')
          .select('id')
          .maybeSingle();
        if (fetchError) throw fetchError;
        id = existing?.id;
        if (!id) throw new Error('No business configuration row found to update.');
        setRecordId(id);
      }

      const { error } = await supabase
        .from('business_config')
        .update({
          business_name: businessForm.business_name,
          contact_number: businessForm.contact_number,
          email_address: businessForm.email_address,
          business_address: businessForm.business_address,
          opening_hour: businessForm.opening_hour,
          closing_hour: businessForm.closing_hour,
          // Task B: persist the four mandatory QR recipient fields.
          qr_account_name: businessForm.qr_account_name,
          qr_account_number: businessForm.qr_account_number,
          fallback_receiver_name: businessForm.fallback_receiver_name,
          fallback_receiver_number: businessForm.fallback_receiver_number,
          qr_config_complete: validateQrRecipients(businessForm).ok,
          slots_per_hour: Number(businessForm.slots_per_hour),
          max_vehicles_per_staff: Number(businessForm.max_vehicles_per_staff),
          booking_lead_time_minutes: Number(businessForm.booking_lead_time_minutes),
          max_advance_days: Number(businessForm.max_advance_days),
          closed_weekdays: businessForm.closed_weekdays || [],
          enforce_capacity: Boolean(businessForm.enforce_capacity),
          custom_services: businessForm.custom_services
        })
        .eq('id', id);

      if (error) throw error;

      await refreshConfig();
      setPristine(businessForm); // Saved state becomes the new baseline.
      setMessage({ type: 'success', text: 'Business settings saved successfully!' });
    } catch (err) {
      console.error('Save failed:', err);
      setMessage({ type: 'error', text: err.message || 'Failed to save settings. Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  // ---- Service catalog helpers (Tab 3) ----
  const persistCustomServices = (next) => {
    setBusinessForm((prev) => ({ ...prev, custom_services: next }));
    // Mirror to the local cache the pricing catalog reads from, so changes
    // take effect immediately for the booking wizard without a DB round-trip.
    try { localStorage.setItem('speedway_custom_services', JSON.stringify(next)); } catch { /* ignore quota errors */ }
  };

  const addOrUpdateService = () => {
    if (!newService.name.trim()) {
      setMessage({ type: 'error', text: 'Service name is required.' });
      return;
    }
    if (newService.price === '' || Number(newService.price) < 0) {
      setMessage({ type: 'error', text: 'Enter a valid service price.' });
      return;
    }

    const item = {
      id: editingServiceId || `custom_${Date.now()}`,
      name: newService.name.trim(),
      price: Number(newService.price) || 0,
      description: newService.description.trim() || 'Admin-added service',
      durationMinutes: Number(newService.durationMinutes) || 60,
      archived: false,
      updatedAt: new Date().toISOString()
    };

    const next = editingServiceId
      ? businessForm.custom_services.map((s) => (s.id === editingServiceId ? { ...s, ...item } : s))
      : [...businessForm.custom_services, item];

    persistCustomServices(next);
    setNewService(EMPTY_NEW_SERVICE);
    setEditingServiceId(null);
    setMessage({ type: 'success', text: `${editingServiceId ? 'Service updated' : 'Service added'}. Remember to save changes.` });
  };

  const editService = (service) => {
    setEditingServiceId(service.id);
    setNewService({
      name: service.name || '',
      price: String(service.price ?? ''),
      description: service.description || '',
      durationMinutes: String(service.durationMinutes || 60)
    });
  };

  const archiveService = (id) => {
    const next = businessForm.custom_services.map((s) =>
      s.id === id ? { ...s, archived: true, archivedAt: new Date().toISOString() } : s
    );
    persistCustomServices(next);
    setMessage({ type: 'success', text: 'Service archived. Historical bookings are preserved.' });
  };

  const restoreService = (id) => {
    const next = businessForm.custom_services.map((s) =>
      s.id === id ? { ...s, archived: false } : s
    );
    persistCustomServices(next);
    setMessage({ type: 'success', text: 'Service restored.' });
  };

  const activeServices = useMemo(
    () => businessForm.custom_services.filter((s) => !s.archived),
    [businessForm.custom_services]
  );
  const archivedServices = useMemo(
    () => businessForm.custom_services.filter((s) => s.archived),
    [businessForm.custom_services]
  );

  const tabs = [
    { id: 'profile', label: 'Business Profile', icon: Building },
    { id: 'hours', label: 'Hours & Capacity', icon: Clock },
    { id: 'schedule', label: 'Schedule Rules', icon: CalendarClock },
    { id: 'services', label: 'Service Catalog', icon: Wrench },
    { id: 'promos', label: 'Promo Management', icon: Tag }
  ];

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px', color: 'var(--admin-text-secondary)', fontWeight: 950, fontSize: '0.75rem', letterSpacing: '2px' }}>
        SYNCHRONIZING BUSINESS CONFIGURATION...
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingBottom: '2rem' }}>
      {/* Header */}
      <div>
        <h1 style={{ margin: 0, fontSize: '1.35rem', fontWeight: 950, color: 'var(--admin-text-primary)', textTransform: 'uppercase', letterSpacing: '1px' }}>
          Business Hub
        </h1>
        <p style={{ margin: '0.35rem 0 0 0', fontSize: '0.8rem', color: 'var(--admin-text-secondary)', fontWeight: 600 }}>
          Manage store details, operating schedules, catalog offerings, and promotional campaigns.
        </p>
      </div>

      {/* Tab Navigation */}
      <div style={{ borderBottom: '1px solid var(--admin-border)' }}>
        <nav
          aria-label="Tabs"
          style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', overflowX: 'auto', whiteSpace: 'nowrap', paddingBottom: '1px' }}
        >
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = currentTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => handleTabChange(tab.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  flexShrink: 0,
                  padding: '0.75rem 0.9rem',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: `2px solid ${isActive ? 'var(--admin-brand)' : 'transparent'}`,
                  color: isActive ? 'var(--admin-brand)' : 'var(--admin-text-secondary)',
                  fontSize: '0.78rem',
                  fontWeight: isActive ? 900 : 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  cursor: 'pointer',
                  transition: 'color 0.2s, border-color 0.2s'
                }}
              >
                <Icon size={15} strokeWidth={2.25} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Status Alert Banner */}
      {message.text && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.65rem',
          padding: '0.85rem 1rem',
          borderRadius: 'var(--admin-radius)',
          fontSize: '0.78rem',
          fontWeight: 700,
          background: message.type === 'error' ? 'rgba(239, 68, 68, 0.1)' : 'var(--status-success-soft)',
          border: `1px solid ${message.type === 'error' ? 'rgba(239, 68, 68, 0.35)' : 'var(--status-success-border)'}`,
          color: message.type === 'error' ? '#f87171' : 'var(--status-success)'
        }}>
          {message.type === 'error' ? <AlertCircle size={16} /> : <CheckCircle size={16} />}
          <span>{message.text}</span>
        </div>
      )}

      {/* Tab Panels */}
      <div>
        {/* Tab 1: Business Profile & Payment Details */}
        {currentTab === 'profile' && (
          <form onSubmit={handleSaveSection} style={cardStyle}>
            <SectionHeading>Store Identification &amp; Contact</SectionHeading>
            <div style={gridStyle}>
              <Field label="Business Name" required>
                <input
                  type="text"
                  value={businessForm.business_name}
                  onChange={(e) => handleInputChange('business_name', e.target.value)}
                  style={inputStyle}
                  placeholder="e.g. Speedway Detail Studio"
                />
              </Field>
              <Field label="Contact Number">
                <input
                  type="text"
                  value={businessForm.contact_number}
                  onChange={(e) => handleInputChange('contact_number', e.target.value)}
                  style={inputStyle}
                  placeholder="e.g. 0912 345 6789"
                />
              </Field>
              <Field label="Email Address">
                <input
                  type="email"
                  value={businessForm.email_address}
                  onChange={(e) => handleInputChange('email_address', e.target.value)}
                  style={inputStyle}
                  placeholder="e.g. hello@speedway.com"
                />
              </Field>
              <Field label="Business Address">
                <input
                  type="text"
                  value={businessForm.business_address}
                  onChange={(e) => handleInputChange('business_address', e.target.value)}
                  style={inputStyle}
                  placeholder="Street, City"
                />
              </Field>
            </div>

            <SectionHeading style={{ paddingTop: '0.5rem' }}>Payment &amp; Settlement Details</SectionHeading>
            <div style={gridStyle}>
              <Field label="QR Account Name" required>
                <input
                  type="text"
                  value={businessForm.qr_account_name}
                  onChange={(e) => handleInputChange('qr_account_name', e.target.value)}
                  style={inputStyle}
                  placeholder="Primary recipient name"
                />
              </Field>
              <Field label="QR Account Number" required>
                <input
                  type="text"
                  value={businessForm.qr_account_number}
                  onChange={(e) => handleInputChange('qr_account_number', e.target.value)}
                  style={inputStyle}
                  placeholder="Primary recipient number"
                />
              </Field>
              <Field label="Fallback Receiver Name" required>
                <input
                  type="text"
                  value={businessForm.fallback_receiver_name}
                  onChange={(e) => handleInputChange('fallback_receiver_name', e.target.value)}
                  style={inputStyle}
                  placeholder="Fallback recipient name"
                />
              </Field>
              <Field label="Fallback Receiver Number" required>
                <input
                  type="text"
                  value={businessForm.fallback_receiver_number}
                  onChange={(e) => handleInputChange('fallback_receiver_number', e.target.value)}
                  style={inputStyle}
                  placeholder="Fallback recipient number"
                />
              </Field>
            </div>

            {/* Task B: all four fields are mandatory. Show the exact gaps
                inline so the operator is never left guessing why Save is off. */}
            {(() => {
              const qr = validateQrRecipients(businessForm);
              if (qr.ok) return null;
              const parts = [];
              if (qr.missing.length) parts.push(`missing: ${qr.missing.join(', ')}`);
              if (qr.invalid.length) parts.push(`invalid characters: ${qr.invalid.join(', ')}`);
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.75rem', padding: '0.7rem 0.9rem', background: 'rgba(var(--admin-brand-rgb), 0.08)', border: '1px solid var(--status-danger)', borderRadius: 'var(--admin-radius-sm)', color: 'var(--status-danger)', fontSize: '0.78rem', fontWeight: 800 }}>
                  <AlertCircle size={16} /> All fields are required — {parts.join('; ')}
                </div>
              );
            })()}

            {/* Task B: changing the QR requires the OTP-verified flow. */}
            <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', padding: '0.9rem 1rem', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-sm)' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--admin-text-secondary)', minWidth: 0 }}>
                QR configuration is version <strong style={{ color: 'var(--admin-text-primary)' }}>v{businessForm.qr_config_version || 1}</strong>. Changing it requires email OTP verification.
              </div>
              <button
                type="button"
                onClick={() => setShowQrModal(true)}
                style={{ minHeight: '2.5rem', padding: '0.65rem 1.1rem', background: 'var(--admin-brand)', color: 'var(--admin-text-on-brand)', border: 'none', borderRadius: 'var(--admin-radius-sm)', fontWeight: 950, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.5px', cursor: 'pointer', flexShrink: 0 }}
              >
                Change QR
              </button>
            </div>

            <SaveBar
              canSave={canSave('profile')}
              saving={saving}
              dirty={isDirty('profile')}
              label="Save Profile Changes"
            />
          </form>
        )}

        {/* Tab 2: Hours & Service Capacity */}
        {currentTab === 'hours' && (
          <form onSubmit={handleSaveSection} style={cardStyle}>
            <SectionHeading>Operating Schedule &amp; Daily Capacity</SectionHeading>
            <div style={gridStyle}>
              <Field label="Opening Hour" required>
                <input
                  type="text"
                  value={businessForm.opening_hour}
                  onChange={(e) => handleInputChange('opening_hour', e.target.value)}
                  placeholder="e.g. 08:00 AM"
                  style={inputStyle}
                />
              </Field>
              <Field label="Closing Hour" required>
                <input
                  type="text"
                  value={businessForm.closing_hour}
                  onChange={(e) => handleInputChange('closing_hour', e.target.value)}
                  placeholder="e.g. 05:00 PM"
                  style={inputStyle}
                />
              </Field>
              <Field label="Booking Slots Per Hour" required>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={businessForm.slots_per_hour}
                  onChange={(e) => handleInputChange('slots_per_hour', e.target.value)}
                  style={inputStyle}
                />
              </Field>
              <Field label="Max Vehicles Per Staff Member" required>
                <input
                  type="number"
                  min="1"
                  max="12"
                  value={businessForm.max_vehicles_per_staff}
                  onChange={(e) => handleInputChange('max_vehicles_per_staff', e.target.value)}
                  style={inputStyle}
                />
              </Field>
            </div>
            {!sectionValid('hours') && (
              <Hint>Opening/closing hours are required and capacities must be at least 1.</Hint>
            )}

            <SaveBar
              canSave={canSave('hours')}
              saving={saving}
              dirty={isDirty('hours')}
              label="Save Schedule Changes"
            />
          </form>
        )}

        {/* Tab 3: Schedule Rules (Batch 6 — booking restrictions) */}
        {currentTab === 'schedule' && (
          <form onSubmit={handleSaveSection} style={cardStyle}>
            <SectionHeading>Booking Window &amp; Lead Time</SectionHeading>
            <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--admin-text-secondary)', fontWeight: 600, lineHeight: 1.6 }}>
              These rules are enforced on the customer calendar and again on the server before any booking is created.
            </p>
            <div style={gridStyle}>
              <Field label="Minimum Lead Time (minutes)" required>
                <input
                  type="number"
                  min="0"
                  max="43200"
                  step="15"
                  value={businessForm.booking_lead_time_minutes}
                  onChange={(e) => handleInputChange('booking_lead_time_minutes', e.target.value)}
                  style={inputStyle}
                />
              </Field>
              <Field label="Max Advance Booking Window (days)" required>
                <input
                  type="number"
                  min="1"
                  max="365"
                  value={businessForm.max_advance_days}
                  onChange={(e) => handleInputChange('max_advance_days', e.target.value)}
                  style={inputStyle}
                />
              </Field>
            </div>

            <SectionHeading style={{ paddingTop: '0.5rem' }}>Closed Days</SectionHeading>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }} role="group" aria-label="Closed weekdays">
              {WEEKDAYS.map((day) => {
                const isClosed = (businessForm.closed_weekdays || []).includes(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    onClick={() => toggleClosedWeekday(day.value)}
                    aria-pressed={isClosed}
                    title={isClosed ? `${day.long} — closed` : `${day.long} — open`}
                    style={{
                      minWidth: '64px',
                      padding: '0.6rem 0.85rem',
                      borderRadius: 'var(--admin-radius-sm)',
                      background: isClosed ? 'rgba(var(--admin-brand-rgb), 0.12)' : 'var(--admin-input-bg, var(--admin-bg))',
                      border: `1px solid ${isClosed ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
                      color: isClosed ? 'var(--admin-brand)' : 'var(--admin-text-primary)',
                      fontSize: '0.72rem',
                      fontWeight: 900,
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                      cursor: 'pointer',
                      transition: 'all 0.2s'
                    }}
                  >
                    {day.short}
                  </button>
                );
              })}
            </div>
            <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--admin-text-secondary)', fontWeight: 700 }}>
              Tap a day to toggle the shop closed. Closed days are greyed out on the customer calendar.
            </p>

            <SectionHeading style={{ paddingTop: '0.5rem' }}>Capacity Enforcement</SectionHeading>
            <button
              type="button"
              onClick={() => handleInputChange('enforce_capacity', !businessForm.enforce_capacity)}
              aria-pressed={Boolean(businessForm.enforce_capacity)}
              style={{
                ...insetPanelStyle,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '1rem',
                cursor: 'pointer',
                textAlign: 'left',
                width: '100%'
              }}
            >
              <span style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 950, color: 'var(--admin-text-primary)' }}>
                  Enforce slot capacity
                </span>
                <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--admin-text-secondary)', lineHeight: 1.5 }}>
                  When ON, slots respect the "Slots Per Hour" and "Max Vehicles Per Staff" limits. When OFF, capacity checks are skipped.
                </span>
              </span>
              <span
                aria-hidden="true"
                style={{
                  flexShrink: 0,
                  width: '48px',
                  height: '26px',
                  borderRadius: '999px',
                  background: businessForm.enforce_capacity ? 'var(--admin-brand)' : 'var(--admin-border)',
                  position: 'relative',
                  transition: 'background 0.2s'
                }}
              >
                <span style={{
                  position: 'absolute',
                  top: '3px',
                  left: businessForm.enforce_capacity ? '25px' : '3px',
                  width: '20px',
                  height: '20px',
                  borderRadius: '50%',
                  background: '#fff',
                  transition: 'left 0.2s'
                }} />
              </span>
            </button>

            {!sectionValid('schedule') && (
              <Hint>Lead time must be 0–43,200 minutes and the advance window 1–365 days.</Hint>
            )}

            <SaveBar
              canSave={canSave('schedule')}
              saving={saving}
              dirty={isDirty('schedule')}
              label="Save Schedule Rules"
            />
          </form>
        )}

        {/* Tab 3: Service Catalog Configuration */}
        {currentTab === 'services' && (
          <form onSubmit={handleSaveSection} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--admin-border)', paddingBottom: '0.75rem', gap: '1rem', flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0, fontSize: '0.85rem', fontWeight: 950, color: 'var(--admin-text-primary)', textTransform: 'uppercase', letterSpacing: '1px' }}>
                Custom Service Catalog
              </h2>
              <span style={{ fontSize: '0.68rem', fontWeight: 800, color: 'var(--admin-text-secondary)' }}>
                {activeServices.length} active &middot; {archivedServices.length} archived
              </span>
            </div>
            <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--admin-text-secondary)', fontWeight: 600, lineHeight: 1.6 }}>
              Add, edit, or archive custom services. These appear to customers alongside the standard catalog. Changes are committed to the database when you save.
            </p>

            {/* Add / edit service row */}
            <div style={{ ...insetPanelStyle, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.75rem' }}>
                <input
                  type="text"
                  placeholder="Service name"
                  value={newService.name}
                  onChange={(e) => setNewService({ ...newService, name: e.target.value })}
                  style={inputStyle}
                />
                <input
                  type="number"
                  min="0"
                  placeholder="Price (₱)"
                  value={newService.price}
                  onChange={(e) => setNewService({ ...newService, price: e.target.value })}
                  style={inputStyle}
                />
                <input
                  type="number"
                  min="15"
                  step="15"
                  placeholder="Minutes"
                  value={newService.durationMinutes}
                  onChange={(e) => setNewService({ ...newService, durationMinutes: e.target.value })}
                  style={inputStyle}
                />
                <button
                  type="button"
                  onClick={addOrUpdateService}
                  style={{ ...buttonBase, background: 'var(--admin-brand)', color: 'var(--admin-text-on-brand)', border: '1px solid var(--admin-brand)' }}
                >
                  {editingServiceId ? 'Update Service' : (<><Plus size={15} /> Add Service</>)}
                </button>
              </div>
              <input
                type="text"
                placeholder="Service description (optional)"
                value={newService.description}
                onChange={(e) => setNewService({ ...newService, description: e.target.value })}
                style={inputStyle}
              />
              {editingServiceId && (
                <button
                  type="button"
                  onClick={() => { setEditingServiceId(null); setNewService(EMPTY_NEW_SERVICE); }}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', background: 'transparent', border: 'none', color: 'var(--admin-text-secondary)', fontSize: '0.72rem', fontWeight: 800, cursor: 'pointer', padding: 0, alignSelf: 'flex-start' }}
                >
                  <X size={14} /> Cancel edit
                </button>
              )}
            </div>

            {/* Active services */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {activeServices.length > 0 ? (
                activeServices.map((service) => (
                  <div
                    key={service.id}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.85rem', padding: '0.85rem 1rem', borderRadius: 'var(--admin-radius-sm)', border: '1px solid var(--admin-border)', background: 'var(--admin-bg)', flexWrap: 'wrap' }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <p style={{ margin: 0, fontSize: '0.85rem', fontWeight: 900, color: 'var(--admin-text-primary)' }}>{service.name}</p>
                      <p style={{ margin: '0.15rem 0 0 0', fontSize: '0.7rem', color: 'var(--admin-text-secondary)', fontWeight: 700 }}>
                        ₱{Number(service.price || 0).toLocaleString()} &middot; {Number(service.durationMinutes || 60)}m
                        {service.description ? ` · ${service.description}` : ''}
                      </p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                      <button type="button" onClick={() => editService(service)} style={ghostButton}>
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => archiveService(service.id)}
                        style={{ ...ghostButton, color: 'var(--status-danger)', borderColor: 'rgba(239, 68, 68, 0.4)' }}
                      >
                        <Trash2 size={13} /> Archive
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ ...insetPanelStyle, fontSize: '0.74rem', color: 'var(--admin-text-secondary)', fontWeight: 600 }}>
                  No custom services configured. Standard catalog defaults are active.
                </div>
              )}
            </div>

            {/* Archived drawer */}
            {archivedServices.length > 0 && (
              <div style={{ borderTop: '1px solid var(--admin-border)', paddingTop: '0.75rem' }}>
                <button
                  type="button"
                  onClick={() => setShowArchived((prev) => !prev)}
                  style={{ background: 'transparent', border: 'none', color: 'var(--admin-text-secondary)', fontSize: '0.72rem', fontWeight: 900, cursor: 'pointer', padding: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}
                >
                  {showArchived ? 'Hide' : 'Show'} archived services ({archivedServices.length})
                </button>
                {showArchived && (
                  <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {archivedServices.map((service) => (
                      <div
                        key={service.id}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.85rem', padding: '0.75rem 1rem', borderRadius: 'var(--admin-radius-sm)', border: '1px dashed var(--admin-border)', background: 'var(--admin-bg)', flexWrap: 'wrap' }}
                      >
                        <div style={{ minWidth: 0, opacity: 0.65, flex: 1 }}>
                          <p style={{ margin: 0, fontSize: '0.82rem', fontWeight: 900, color: 'var(--admin-text-primary)' }}>{service.name}</p>
                          <p style={{ margin: '0.15rem 0 0 0', fontSize: '0.7rem', color: 'var(--admin-text-secondary)', fontWeight: 700 }}>
                            ₱{Number(service.price || 0).toLocaleString()} &middot; {Number(service.durationMinutes || 60)}m
                          </p>
                        </div>
                        <button type="button" onClick={() => restoreService(service.id)} style={{ ...ghostButton, flexShrink: 0 }}>
                          <ArchiveRestore size={13} /> Restore
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <SaveBar
              canSave={canSave('services')}
              saving={saving}
              dirty={isDirty('services')}
              label="Save Catalog Changes"
            />
          </form>
        )}

        {/* Tab 4: Promo & Package Rules */}
        {currentTab === 'promos' && (
          <div style={{ ...cardStyle, display: 'block' }}>
            <PromoManager isMobile={false} />
          </div>
        )}
      </div>

      {/* Task B: QR change is gated behind a 6-digit email OTP. */}
      <QrChangeOtpModal
        open={showQrModal}
        currentConfig={businessForm}
        onClose={() => setShowQrModal(false)}
        onCommitted={() => { fetchBusinessConfig(); }}
      />

      {/* Task B: block navigation while there are unsaved edits. */}
      <LeaveGuardModal
        open={leaveGuard.modalProps.open}
        message={leaveGuard.modalProps.message}
        onStay={leaveGuard.modalProps.onStay}
        onLeave={leaveGuard.modalProps.onLeave}
      />
    </div>
  );
}
