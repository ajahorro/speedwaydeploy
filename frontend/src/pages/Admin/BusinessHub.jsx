import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Building, Clock, Wrench, Tag, Save, AlertCircle, CheckCircle,
  Plus, X, Trash2, ArchiveRestore, CalendarClock, HelpCircle, ChevronUp, ChevronDown
} from 'lucide-react';
import { useConfig } from '../../context/ConfigContext';
import { supabase } from '../../lib/supabase';
import PromoManager from '../../components/AdminSchedule/PromoManager';
import QrChangeOtpModal from '../../components/Business/QrChangeOtpModal';
import { validateQrRecipients } from '../../services/qrSecurityService';
import { buildBusinessConfigUpdatePayload, stripUnsupportedBusinessConfigColumns } from '../../services/businessConfigPayload';
import { sanitizeAlphaNum, sanitizeByFieldType, VEHICLE_TYPE_OPTIONS } from '../../config/constants';
import { SERVICES_DATA } from '../../data/servicesCatalog';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import LeaveGuardModal from '../../components/LeaveGuardModal';
import SegmentedTimePicker from '../../components/AdminSchedule/SegmentedTimePicker';
import { BACKEND_URL } from '../../config/api';

const TAB_KEYS = ['profile', 'hours', 'schedule', 'services', 'promos'];

// The fields each section owns (mirrors handleSaveSection's UPDATE payload).
const SECTION_FIELDS = {
  profile: [
    'business_name', 'contact_number', 'email_address', 'business_address',
    // Task B: the primary QR recipient fields plus the uploaded QR image.
    'qr_account_name', 'qr_account_number', 'payment_qr_url',
    'faqs'
  ],
  hours: ['opening_hour', 'closing_hour', 'slots_per_hour', 'max_vehicles_per_staff'],
  schedule: ['booking_lead_time_minutes', 'max_advance_days', 'closed_weekdays', 'enforce_capacity'],
  services: ['custom_services', 'vehicle_types'],
  faqs: ['faqs']
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

const DEFAULT_VEHICLE_TYPES = ['Sedan', 'SUV', 'Van/L300', 'Regular', 'Bigbike'];
const VEHICLE_TYPE_CHOICES = DEFAULT_VEHICLE_TYPES;
const DEFAULT_VEHICLE_CATEGORY_OPTIONS = VEHICLE_TYPE_OPTIONS.map((option) => ({
  value: option.value,
  label: option.label
}));

const normalizeVehicleCategoryKey = (value = '') => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const aliasMap = {
    sedan: 'Sedan',
    'sedan/hatchback': 'Sedan',
    hatchback: 'Sedan',
    suv: 'SUV',
    'suv/crossover': 'SUV',
    crossover: 'SUV',
    'pickup/van': 'Van/L300',
    pickup: 'Van/L300',
    van: 'Van/L300',
    'van/l300': 'Van/L300',
    motorcycle: 'Regular',
    'motorcycle regular': 'Regular',
    regular: 'Regular',
    bigbike: 'Bigbike'
  };

  const normalized = raw.toLowerCase().replace(/[_/\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return aliasMap[normalized] || raw;
};

const getVehicleTypeLabel = (value = '') => {
  const normalized = normalizeVehicleCategoryKey(value);
  const match = VEHICLE_TYPE_OPTIONS.find((option) => normalizeVehicleCategoryKey(option.value) === normalized);
  return match ? match.label : normalized || 'Vehicle';
};

const flattenDefaultServices = () => {
  const rows = [];
  Object.values(SERVICES_DATA || {}).forEach((services) => {
    (services || []).forEach((service) => {
      const priceMap = service?.prices || {};
      Object.entries(priceMap).forEach(([vehicleKey, price]) => {
        const normalizedType = normalizeVehicleCategoryKey(vehicleKey);
        rows.push({
          id: `${service.id || service.name}-${normalizedType}`,
          name: service.name,
          description: service.desc || service.description || '',
          price: Number(price || 0),
          durationMinutes: Number(service.durationMinutes || 60),
          vehicleType: normalizedType,
          vehicle_type: normalizedType,
          applicableVehicleTypes: [normalizedType],
          vehicleTypes: [normalizedType],
          is_active: true,
          archived: false,
          source: 'default'
        });
      });
    });
  });
  return rows;
};

const mergeCatalogServices = (customServices = []) => {
  const defaults = flattenDefaultServices();
  const custom = Array.isArray(customServices) ? customServices.filter(Boolean) : [];
  const merged = [...defaults, ...custom];
  const unique = new Map();

  merged.forEach((service) => {
    const key = service.id || `${service.name}-${service.vehicleType || service.vehicle_type || 'default'}`;
    unique.set(key, service);
  });

  return [...unique.values()];
};

const EMPTY_NEW_SERVICE = {
  name: '',
  price: '',
  description: '',
  durationMinutes: '60',
  applicableVehicleTypes: ['Sedan'],
  vehicleType: 'Sedan',
  is_active: true
};

const createServiceDraft = (overrides = {}) => ({
  id: overrides.id || (`draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
  collapsed: false,
  ...EMPTY_NEW_SERVICE,
  ...overrides,
  applicableVehicleTypes: Array.isArray(overrides.applicableVehicleTypes) && overrides.applicableVehicleTypes.length
    ? overrides.applicableVehicleTypes
    : (overrides.vehicleType ? [overrides.vehicleType] : ['Sedan'])
});

// Tier 2.8: FAQ editor row seed. FAQs persist to business_config.faqs and render
// on the public landing page in array order.
const EMPTY_NEW_FAQ = { question: '', answer: '' };
const DEFAULT_FAQ_STARTER_QUESTIONS = [
  'How long does ceramic coating last?',
  'What is the booking process?',
  'Do you offer mobile services?',
  'What payment methods do you accept?',
  'Do I need to leave my car overnight?'
];

// Section 3.2: convert a stored business-hours string into the 24h "HH:MM" value
// a <input type="time"> expects. Handles the legacy "08:00 AM" display format and
// already-24h "17:00" values alike, defaulting to 08:00 / 18:00 when unset.
const formatTimeForInput = (value, fallback = '08:00') => {
  if (!value) return fallback;
  const str = String(value).trim();
  const upper = str.toUpperCase();
  if (!upper.includes('AM') && !upper.includes('PM')) return str.slice(0, 5);
  const [time, modifier] = upper.split(' ');
  let [h, m] = time.split(':');
  h = parseInt(h, 10);
  if (Number.isNaN(h)) return fallback;
  if (modifier === 'PM' && h < 12) h += 12;
  if (modifier === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(m || '00').padStart(2, '0')}`;
};

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
  const [servicePanels, setServicePanels] = useState({ existing: false, add: false, vehicle: false });
  const [selectedVehicleFilter, setSelectedVehicleFilter] = useState('All');
  const [newServiceForm, setNewServiceForm] = useState({
    targetVehicleCategory: 'Sedan',
    name: '',
    price: '',
    duration: '60',
    description: ''
  });
  const [vehicleCategoryForm, setVehicleCategoryForm] = useState({
    name: '',
    serviceName: '',
    price: '',
    duration: '60',
    description: ''
  });
  const [editingService, setEditingService] = useState(null);
  const [editingServiceForm, setEditingServiceForm] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  // Tier 2.8: FAQ catalog editor state (add / edit / delete / reorder).
  const [faqForm, setFaqForm] = useState(EMPTY_NEW_FAQ);
  const [editingFaqId, setEditingFaqId] = useState(null);
  const [faqEditorOpen, setFaqEditorOpen] = useState(false);
  const [faqPanels, setFaqPanels] = useState({});
  // Section 3.1: Delete confirmation. The service pending deletion is held here so
  // that choosing "Keep Editing" (Decline) simply clears it and leaves the form
  // and any in-progress edit untouched.
  const [pendingDelete, setPendingDelete] = useState(null);

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
    payment_qr_url: '',
    qr_config_version: 1,
    qr_config_complete: false,
    slots_per_hour: 2,
    max_vehicles_per_staff: 1,
    booking_lead_time_minutes: 120,
    max_advance_days: 30,
    closed_weekdays: [],
    enforce_capacity: true,
    custom_services: [],
    vehicle_types: [...DEFAULT_VEHICLE_TYPES],
    faqs: []
  });
  const [pristine, setPristine] = useState(null);
  const [recordId, setRecordId] = useState(null);
  // Task B: the QR change modal owns its own OTP flow. Saving the profile does
  // NOT commit QR changes — those go through the verified [Change QR] path only.
  const [showQrModal, setShowQrModal] = useState(false);
  const [restrictionDate, setRestrictionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [blockedSlots, setBlockedSlots] = useState([]);
  const [restrictionForm, setRestrictionForm] = useState({
    scope: 'day',
    startDate: new Date().toISOString().slice(0, 10),
    endDate: new Date().toISOString().slice(0, 10),
    startTime: '08:00:00',
    endTime: '17:00:00',
    reason: ''
  });

  useEffect(() => {
    fetchBusinessConfig();
  }, []);

  useEffect(() => {
    if (currentTab === 'schedule') {
      fetchBlockedSlotsForDate(restrictionDate);
    }
  }, [currentTab, restrictionDate]);

  const fetchBlockedSlotsForDate = async (dateValue) => {
    if (!dateValue) return;
    try {
      const { data, error } = await supabase
        .from('blocked_slots')
        .select('*')
        .eq('block_date', dateValue)
        .order('start_time', { ascending: true, nullsFirst: true });

      if (error) throw error;
      setBlockedSlots(data || []);
    } catch (err) {
      console.error('Failed to load blocked slots:', err);
      setBlockedSlots([]);
    }
  };

  const fetchBusinessConfig = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('business_config')
        .select('*')
        .maybeSingle();

      if (error) throw error;
      if (data) {
        const configuredServices = Array.isArray(data.custom_services) ? data.custom_services : [];
        const mergedServices = configuredServices.length > 0 ? configuredServices : flattenDefaultServices();
        const merged = {
          business_name: data.business_name || '',
          contact_number: data.contact_number || '',
          email_address: data.email_address || '',
          business_address: data.business_address || '',
          opening_hour: data.opening_hour || '',
          closing_hour: data.closing_hour || '',
          qr_account_name: data.qr_account_name || '',
          qr_account_number: data.qr_account_number || '',
          payment_qr_url: data.payment_qr_url || data.gcash_qr_url || data.qr_photo_url || '',
          qr_config_version: data.qr_config_version ?? 1,
          qr_config_complete: data.qr_config_complete === true,
          slots_per_hour: data.slots_per_hour ?? 2,
          max_vehicles_per_staff: data.max_vehicles_per_staff ?? 1,
          booking_lead_time_minutes: data.booking_lead_time_minutes ?? 120,
          max_advance_days: data.max_advance_days ?? 30,
          closed_weekdays: Array.isArray(data.closed_weekdays) ? data.closed_weekdays : [],
          enforce_capacity: data.enforce_capacity !== false,
          custom_services: mergedServices,
          vehicle_types: Array.isArray(data.vehicle_types) && data.vehicle_types.length
            ? data.vehicle_types
            : [...DEFAULT_VEHICLE_TYPES],
          faqs: Array.isArray(data.faqs) ? data.faqs : []
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
  // NOTE: computed further below, AFTER `isDirty` is defined. Referencing the
  // `isDirty` const here (above its declaration) would hit its temporal dead
  // zone and crash the whole page on first render.

  const handleTabChange = (tabKey) => {
    const nextTab = () => setSearchParams({ tab: tabKey });
    if (!anyDirty) {
      nextTab();
      return;
    }
    leaveGuard.confirmNavigation(nextTab);
  };

  const sanitizeBusinessHubValue = (field, value = '') => {
    const raw = String(value ?? '');
    const fieldTypeMap = {
      business_name: 'alphaNum',
      contact_number: 'phone',
      email_address: 'email',
      business_address: 'address',
      qr_account_name: 'qrName',
      qr_account_number: 'qrNumber',
      restriction_reason: 'alphaNum',
      reason: 'alphaNum',
      name: 'alphaNum',
      serviceName: 'alphaNum',
      description: 'alphaNum',
      question: 'alphaNum',
      answer: 'alphaNum',
      targetVehicleCategory: 'alphaNum',
      vehicleCategory: 'alphaNum',
      payment_qr_url: null,
    };

    if (fieldTypeMap[field] === null) return raw;
    if (field === 'qr_account_name') return raw.replace(/[^a-zA-Z\s]/g, '').replace(/\s+/g, ' ');
    if (field === 'qr_account_number') return raw.replace(/[^\d\s-]/g, '').replace(/\s+/g, ' ');
    return sanitizeByFieldType(raw, fieldTypeMap[field] || 'alphaNum');
  };

  const sanitizeNumericText = (value, allowDecimal = false) => {
    const raw = String(value ?? '');
    const cleaned = raw.replace(/[^\d.]/g, '');
    const withoutExtraDots = cleaned.replace(/\.(?=.*\.)/g, '');
    if (!allowDecimal) return withoutExtraDots.replace(/\./g, '');
    const [whole, ...rest] = withoutExtraDots.split('.');
    return rest.length ? `${whole}.${rest.join('')}` : whole;
  };

  const handleInputChange = (field, value) => {
    // Task B: strict field-aware sanitization on every free-text config field.
    // Numeric and boolean inputs bypass this so they remain valid numbers.
    const TEXT_FIELDS = [
      'business_name', 'contact_number', 'email_address', 'business_address',
      'qr_account_name', 'qr_account_number',
    ];
    const nextValue = field === 'payment_qr_url' ? value : TEXT_FIELDS.includes(field) ? sanitizeBusinessHubValue(field, value) : value;
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

  // Task B: block tab switches / navigation while a section has unsaved edits.
  // Declared here so it sits AFTER `isDirty` — the hook is called unconditionally
  // on every render, preserving hook order.
  const anyDirty = ['profile', 'hours', 'schedule', 'services', 'faqs'].some((s) => isDirty(s));
  const leaveGuard = useUnsavedChangesGuard(anyDirty, { message: 'You have unsaved changes. Are you sure you want to leave? Your changes will be lost.' });

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
      // Closing must be strictly after opening so the shop never opens "backwards".
      const ordered = opening.length > 0 && closing.length > 0 && closing > opening;
      return ordered && slots >= 1 && maxUnits >= 1;
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
      const draftError = serviceDrafts.some((draft) => {
        const hasAnyEntry = draft.name.trim() || draft.price !== '' || draft.description.trim();
        return hasAnyEntry && draft.name.trim() === '';
      });

      const customVehicleTypes = (businessForm.vehicle_types || []).filter((type) => !DEFAULT_VEHICLE_TYPES.includes(type));
      const missingVehicleMappings = customVehicleTypes.filter((type) => {
        const activeServices = (businessForm.custom_services || []).filter((service) => service && service.is_active !== false && service.archived !== true);
        return !activeServices.some((service) => normalizeVehicleTypes(service).includes(type));
      });

      return !draftError && missingVehicleMappings.length === 0;
    }
    if (section === 'faqs') {
      // Valid so long as no in-progress FAQ editor has text but no question.
      return !(faqForm.question.trim() === '' && faqForm.answer.trim() !== '');
    }
    return true;
  };

  const canSave = (section) => !saving && isDirty(section) && sectionValid(section);

  const handleCommitBlock = async () => {
    const dateForBlock = restrictionForm.scope === 'range' ? restrictionForm.startDate : restrictionDate;
    const payload = restrictionForm.scope === 'range'
      ? {
          start_date: restrictionForm.startDate,
          end_date: restrictionForm.endDate,
          start_time: null,
          end_time: null,
          reason: restrictionForm.reason || 'ADMIN BLOCK'
        }
      : restrictionForm.scope === 'window'
        ? {
            block_date: dateForBlock,
            start_time: restrictionForm.startTime,
            end_time: restrictionForm.endTime,
            reason: restrictionForm.reason || 'TIME WINDOW RESTRICTION'
          }
        : {
            block_date: dateForBlock,
            start_time: null,
            end_time: null,
            reason: restrictionForm.reason || 'FULL DAY BLOCK'
          };

    if (restrictionForm.scope === 'range' && (!restrictionForm.startDate || !restrictionForm.endDate)) {
      setMessage({ type: 'error', text: 'Please choose both start and end dates.' });
      return;
    }

    if (restrictionForm.scope === 'range' && restrictionForm.startDate > restrictionForm.endDate) {
      setMessage({ type: 'error', text: 'Start date cannot be after the end date.' });
      return;
    }

    if (!window.confirm('Apply this restriction and immediately enforce it across the booking rules?')) return;

    try {
      const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';
      const res = await fetch(`${BACKEND_URL}/api/admin/blocked-slots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await res.json().catch(() => ({}));

      if (!res.ok || !result.success) {
        const affected = (result.bookings || []).map((booking) => `#${String(booking.id).slice(0, 8).toUpperCase()}`).join(', ');
        throw new Error(affected ? `${result.error} Affected bookings: ${affected}.` : (result.error || 'Failed to create restriction'));
      }

      setMessage({ type: 'success', text: 'Resource restriction saved and now enforced in the booking rules.' });
      setRestrictionForm((prev) => ({ ...prev, reason: '', scope: prev.scope === 'range' ? 'day' : prev.scope }));
      await fetchBlockedSlotsForDate(restrictionForm.scope === 'range' ? restrictionForm.startDate : restrictionDate);
    } catch (err) {
      console.error('Block create failed:', err);
      setMessage({ type: 'error', text: err.message || 'Failed to create resource restriction.' });
    }
  };

  const handleDeleteBlock = async (id) => {
    if (!window.confirm('Lift this restriction and reopen the affected slot(s)?')) return;

    try {
      const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';
      const res = await fetch(`${BACKEND_URL}/api/admin/blocked-slots/${id}`, {
        method: 'DELETE'
      });
      const result = await res.json().catch(() => ({}));

      if (!res.ok || !result.success) {
        throw new Error(result.error || 'Failed to remove restriction');
      }

      setMessage({ type: 'success', text: 'Restriction lifted successfully.' });
      await fetchBlockedSlotsForDate(restrictionDate);
    } catch (err) {
      console.error('Block delete failed:', err);
      setMessage({ type: 'error', text: err.message || 'Failed to lift restriction.' });
    }
  };

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

      const qrConfigComplete = validateQrRecipients(businessForm).ok;
      const primaryPayload = buildBusinessConfigUpdatePayload(businessForm, {
        supportsFaqs: true,
        supportsCustomServices: false,
        supportsVehicleTypes: false,
        qrConfigComplete,
      });

      const { error } = await supabase
        .from('business_config')
        .update(primaryPayload)
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

  const normalizeVehicleTypes = (service) => {
    const rawTypes = Array.isArray(service?.applicableVehicleTypes)
      ? service.applicableVehicleTypes
      : Array.isArray(service?.vehicleTypes)
        ? service.vehicleTypes
        : Array.isArray(service?.applicable_vehicles)
          ? service.applicable_vehicles
          : service?.vehicleType || service?.vehicle_type
            ? [service.vehicleType || service.vehicle_type]
            : ['Sedan'];

    const available = new Set((businessForm.vehicle_types || [...DEFAULT_VEHICLE_TYPES]).concat(DEFAULT_VEHICLE_TYPES));
    const normalized = rawTypes
      .map((type) => normalizeVehicleCategoryKey(type))
      .filter(Boolean)
      .filter((type) => available.has(type) || available.has(normalizeVehicleCategoryKey(type)));

    return [...new Set(normalized.map((type) => normalizeVehicleCategoryKey(type)))];
  };

  const getAvailableVehicleTypes = () => {
    const values = [...new Set([...(businessForm.vehicle_types || [...DEFAULT_VEHICLE_TYPES]), ...DEFAULT_VEHICLE_TYPES])]
      .map((type) => normalizeVehicleCategoryKey(type))
      .filter(Boolean);

    return values;
  };

  const getUnmappedVehicleTypes = () => {
    const activeServices = (businessForm.custom_services || []).filter((service) => service && service.is_active !== false && service.archived !== true);
    return (businessForm.vehicle_types || [])
      .filter((type) => !DEFAULT_VEHICLE_TYPES.includes(type))
      .filter((type) => !activeServices.some((service) => normalizeVehicleTypes(service).includes(type)));
  };

  const addVehicleType = () => {
    const cleaned = String(newVehicleType || '').trim();
    if (!cleaned) return;

    const normalized = cleaned.replace(/\s+/g, ' ');
    const exists = (businessForm.vehicle_types || []).includes(normalized);
    if (exists || DEFAULT_VEHICLE_TYPES.includes(normalized)) {
      setNewVehicleType('');
      return;
    }

    const next = [...(businessForm.vehicle_types || [...DEFAULT_VEHICLE_TYPES]), normalized];
    setBusinessForm((prev) => ({ ...prev, vehicle_types: next }));
    setNewVehicleType('');

    const missing = getUnmappedVehicleTypes();
    if (missing.length > 0) {
      setMessage({ type: 'error', text: `Please configure at least one service for ${missing[0]} before saving.` });
    }
  };

  const removeVehicleType = (vehicleType) => {
    if (DEFAULT_VEHICLE_TYPES.includes(vehicleType)) return;
    setBusinessForm((prev) => ({
      ...prev,
      vehicle_types: (prev.vehicle_types || []).filter((type) => type !== vehicleType),
      custom_services: (prev.custom_services || []).map((service) => ({
        ...service,
        applicableVehicleTypes: (service.applicableVehicleTypes || []).filter((type) => type !== vehicleType),
        vehicleTypes: (service.vehicleTypes || []).filter((type) => type !== vehicleType)
      }))
    }));
  };

  const toggleVehicleTypeSelection = (vehicleType) => {
    setNewService((prev) => {
      const current = Array.isArray(prev.applicableVehicleTypes) ? prev.applicableVehicleTypes : [];
      const next = current.includes(vehicleType)
        ? current.filter((type) => type !== vehicleType)
        : [...current, vehicleType];
      return {
        ...prev,
        applicableVehicleTypes: next.length ? next : ['Sedan'],
        vehicleType: next.length ? next[0] : 'Sedan'
      };
    });
  };

  const addOrUpdateService = (draftId = null) => {
    const draft = draftId ? serviceDrafts.find((item) => item.id === draftId) : newService;
    if (!draft) return;
    if (!draft.name.trim()) {
      setMessage({ type: 'error', text: 'Service name is required.' });
      return;
    }
    if (!Array.isArray(draft.applicableVehicleTypes) || draft.applicableVehicleTypes.length === 0) {
      setMessage({ type: 'error', text: 'Select at least one applicable vehicle type.' });
      return;
    }
    if (draft.price === '' || Number(draft.price) < 0) {
      setMessage({ type: 'error', text: 'Enter a valid service price.' });
      return;
    }

    const vehicleTypes = normalizeVehicleTypes({ applicableVehicleTypes: draft.applicableVehicleTypes });
    const item = {
      id: draft.id.startsWith('draft_') ? `custom_${Date.now()}` : (editingServiceId || draft.id || `custom_${Date.now()}`),
      name: draft.name.trim(),
      price: Number(draft.price) || 0,
      description: draft.description.trim() || 'Admin-added service',
      durationMinutes: Number(draft.durationMinutes) || 60,
      applicableVehicleTypes: vehicleTypes,
      vehicleTypes: vehicleTypes,
      vehicleType: vehicleTypes[0] || 'Sedan',
      vehicle_type: vehicleTypes[0] || 'Sedan',
      is_active: true,
      archived: false,
      updatedAt: new Date().toISOString()
    };

    const next = editingServiceId
      ? businessForm.custom_services.map((s) => (s.id === editingServiceId ? { ...s, ...item } : s))
      : [...businessForm.custom_services, item];

    persistCustomServices(next);
    setServiceDrafts((prev) => prev.filter((entry) => entry.id !== draftId));
    if (!draftId) {
      setNewService(EMPTY_NEW_SERVICE);
    }
    setEditingServiceId(null);
    setMessage({ type: 'success', text: `${editingServiceId ? 'Service updated' : 'Service added'}. Remember to save changes.` });
  };

  const editService = (service) => {
    const vehicleTypes = normalizeVehicleTypes(service);
    const draft = createServiceDraft({
      id: `draft_edit_${service.id}`,
      name: service.name || '',
      price: String(service.price ?? ''),
      description: service.description || '',
      durationMinutes: String(service.durationMinutes || 60),
      applicableVehicleTypes: vehicleTypes.length ? vehicleTypes : ['Sedan'],
      vehicleType: vehicleTypes[0] || 'Sedan',
      is_active: service.is_active !== false && service.archived !== true,
      collapsed: false
    });
    setEditingServiceId(service.id);
    setServiceDrafts((prev) => [...prev, draft]);
    setNewService({ ...draft });
  };

  const archiveService = (id) => {
    const next = businessForm.custom_services.map((s) =>
      s.id === id ? { ...s, archived: true, is_active: false, archivedAt: new Date().toISOString() } : s
    );
    persistCustomServices(next);
    setMessage({ type: 'success', text: 'Service archived. Historical bookings are preserved.' });
  };

  // ---- Section 3.1: Delete with soft-archive fallback ----
  // Opening the confirm does NOT touch the service list, so a Decline/"Keep
  // Editing" reliably preserves whatever the admin was doing (including an
  // in-progress edit in the form above).
  const requestDeleteService = (service) => setPendingDelete(service);
  const cancelDeleteService = () => setPendingDelete(null);

  const confirmDeleteService = async () => {
    const service = pendingDelete;
    if (!service) return;
    setPendingDelete(null);

    // A service tied to ANY booking (past or active) must never be hard-deleted:
    // the booking history references it by name. Ask the backend how many bookings
    // use it and fall back to soft-archiving when the count is non-zero.
    let inUse = false;
    let referenceCount = 0;
    try {
      const res = await fetch(`${BACKEND_URL}/api/admin/services/usage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: [service.name] })
      });
      const result = await res.json();
      if (result?.success) {
        referenceCount = Number(result.usage?.[service.name] || 0);
        inUse = referenceCount > 0;
      }
    } catch {
      // If the check itself fails we take the safe path and archive rather than
      // risk orphaning a booking's historical service name.
      inUse = true;
    }

    if (inUse) {
      const next = businessForm.custom_services.map((s) =>
        s.id === service.id ? { ...s, archived: true, is_active: false, archivedAt: new Date().toISOString() } : s
      );
      persistCustomServices(next);
      setMessage({
        type: 'success',
        text: `"${service.name}" is linked to ${referenceCount || 'existing'} booking(s), so it was archived instead of deleted to preserve booking history.`
      });
    } else {
      const next = businessForm.custom_services.filter((s) => s.id !== service.id);
      persistCustomServices(next);
      // If the row being deleted was open in the editor, drop the stale edit.
      if (editingServiceId === service.id) {
        setEditingServiceId(null);
        setNewService(EMPTY_NEW_SERVICE);
      }
      setMessage({ type: 'success', text: `Service "${service.name}" deleted. Remember to save changes.` });
    }
  };

  const restoreService = (id) => {
    const next = businessForm.custom_services.map((s) =>
      s.id === id ? { ...s, archived: false, is_active: true } : s
    );
    persistCustomServices(next);
    setMessage({ type: 'success', text: 'Service restored.' });
  };

  // ---- FAQ catalog helpers (Tab 4) — Tier 2.8 ----
  // FAQs live in business_config.faqs as an ordered array and render on the
  // public landing page. Order in this list is the display order.
  const setFaqs = (next) => {
    const ordered = next.map((f, i) => ({ ...f, order: i }));
    setBusinessForm((prev) => ({ ...prev, faqs: ordered }));
    setMessage((prev) => (prev.text ? { type: '', text: '' } : prev));
  };

  const addOrUpdateFaq = () => {
    const question = faqForm.question.trim();
    if (!question) {
      setMessage({ type: 'error', text: 'FAQ question is required.' });
      return;
    }

    const item = {
      id: editingFaqId || `faq_${Date.now()}`,
      question,
      answer: faqForm.answer.trim(),
      order: 0
    };

    const currentFaqs = Array.isArray(businessForm.faqs) ? [...businessForm.faqs] : [];
    const next = editingFaqId
      ? (() => {
          const matchIndex = currentFaqs.findIndex((f) => f.id === editingFaqId);
          if (matchIndex >= 0) {
            return currentFaqs.map((f) => (f.id === editingFaqId ? { ...f, ...item } : f));
          }
          return [...currentFaqs, item];
        })()
      : [...currentFaqs, item];

    setFaqs(next);
    setFaqForm(EMPTY_NEW_FAQ);
    setEditingFaqId(null);
    setFaqEditorOpen(false);
    setMessage({ type: 'success', text: `${editingFaqId ? 'FAQ updated' : 'FAQ added'}. Remember to save changes.` });
  };

  const editFaq = (faq) => {
    setEditingFaqId(faq.id);
    setFaqEditorOpen(true);
    setFaqForm({ question: faq.question || '', answer: faq.answer || '' });
  };

  const removeFaq = (id) => {
    setFaqs(businessForm.faqs.filter((f) => f.id !== id));
    if (editingFaqId === id) {
      setEditingFaqId(null);
      setFaqForm(EMPTY_NEW_FAQ);
    }
    setMessage({ type: 'success', text: 'FAQ removed. Remember to save changes.' });
  };

  const moveFaq = (id, direction) => {
    const list = [...businessForm.faqs];
    const index = list.findIndex((f) => f.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    setFaqs(list);
    setMessage({ type: 'success', text: 'FAQ order updated. Remember to save changes.' });
  };

  const visibleFaqs = useMemo(() => {
    const currentFaqs = Array.isArray(businessForm.faqs) && businessForm.faqs.length > 0
      ? businessForm.faqs
      : DEFAULT_FAQ_STARTER_QUESTIONS.map((question, index) => ({
          id: `starter_faq_${index}`,
          question,
          answer: '',
          order: index,
          isStarter: true,
        }));

    return currentFaqs.map((faq, index) => ({
      ...faq,
      order: typeof faq.order === 'number' ? faq.order : index,
    }));
  }, [businessForm.faqs]);

  useEffect(() => {
    setFaqPanels((prev) => {
      const next = { ...prev };
      let changed = false;

      visibleFaqs.forEach((faq) => {
        if (next[faq.id] === undefined) {
          next[faq.id] = false;
          changed = true;
        }
      });

      return changed ? next : prev;
    });
  }, [visibleFaqs]);

  const allLoadedServices = useMemo(
    () => mergeCatalogServices(businessForm.custom_services || []),
    [businessForm.custom_services]
  );

  const activeServices = useMemo(() => {
    const services = selectedVehicleFilter === 'All'
      ? allLoadedServices
      : allLoadedServices.filter((service) => {
          const serviceTypes = normalizeVehicleTypes(service).map((type) => normalizeVehicleCategoryKey(type));
          return serviceTypes.includes(normalizeVehicleCategoryKey(selectedVehicleFilter));
        });
    return services.filter((s) => s.is_active !== false && s.archived !== true);
  }, [allLoadedServices, selectedVehicleFilter]);

  const addServiceDraft = () => {
    setServiceDrafts((prev) => [...prev, createServiceDraft()]);
  };

  const updateDraftField = (draftId, field, value) => {
    const sanitizedValue = ['name', 'description', 'serviceName', 'question', 'answer'].includes(field)
      ? sanitizeBusinessHubValue(field, value)
      : value;
    setServiceDrafts((prev) => prev.map((draft) => draft.id === draftId ? { ...draft, [field]: sanitizedValue } : draft));
    if (draftId === 'new' || !draftId) {
      setNewService((prev) => ({ ...prev, [field]: sanitizedValue }));
    }
  };

  const toggleDraftCollapsed = (draftId) => {
    setServiceDrafts((prev) => prev.map((draft) => draft.id === draftId ? { ...draft, collapsed: !draft.collapsed } : draft));
  };

  const removeDraft = (draftId) => {
    setServiceDrafts((prev) => prev.filter((draft) => draft.id !== draftId));
    if (editingServiceId && draftId === `draft_edit_${editingServiceId}`) {
      setEditingServiceId(null);
      setNewService(EMPTY_NEW_SERVICE);
    }
  };
  const archivedServices = useMemo(() => {
    const services = selectedVehicleFilter === 'All'
      ? allLoadedServices
      : allLoadedServices.filter((service) => {
          const serviceTypes = normalizeVehicleTypes(service).map((type) => normalizeVehicleCategoryKey(type));
          return serviceTypes.includes(normalizeVehicleCategoryKey(selectedVehicleFilter));
        });
    return services.filter((s) => s.is_active === false || s.archived === true);
  }, [allLoadedServices, selectedVehicleFilter]);

  const toggleServicePanel = (panelKey) => {
    setServicePanels((prev) => ({ ...prev, [panelKey]: !prev[panelKey] }));
  };

  const filteredServices = useMemo(() => {
    const services = mergeCatalogServices(businessForm.custom_services || []);
    if (selectedVehicleFilter === 'All') return services;
    const targetKey = normalizeVehicleCategoryKey(selectedVehicleFilter);
    return services.filter((service) => {
      const serviceTypes = normalizeVehicleTypes(service).map((type) => normalizeVehicleCategoryKey(type));
      return serviceTypes.includes(targetKey);
    });
  }, [businessForm.custom_services, selectedVehicleFilter]);

  const saveCatalogState = async (nextCustomServices, nextVehicleTypes, successText) => {
    try {
      let id = recordId;
      if (!id) {
        const { data: existing, error: fetchError } = await supabase
          .from('business_config')
          .select('id')
          .maybeSingle();
        if (fetchError) throw fetchError;
        if (!existing?.id) throw new Error('No business configuration row found to update.');
        id = existing.id;
        setRecordId(id);
      }

      const normalizedVehicleTypes = (nextVehicleTypes && nextVehicleTypes.length ? nextVehicleTypes : [...DEFAULT_VEHICLE_TYPES]).filter(Boolean);
      const primaryPayload = buildBusinessConfigUpdatePayload({
        ...businessForm,
        custom_services: nextCustomServices || [],
        vehicle_types: normalizedVehicleTypes,
      }, {
        supportsFaqs: true,
        supportsCustomServices: true,
        supportsVehicleTypes: true,
      });

      let { error } = await supabase
        .from('business_config')
        .update(primaryPayload)
        .eq('id', id);

      if (error && (
        error.message.includes("Could not find the 'custom_services' column") ||
        error.message.includes("Could not find the 'vehicle_types' column") ||
        error.message.includes("Could not find the 'faqs' column")
      )) {
        const retryPayload = stripUnsupportedBusinessConfigColumns(primaryPayload, error);
        const retryResult = await supabase
          .from('business_config')
          .update(retryPayload)
          .eq('id', id);
        error = retryResult.error;
      }

      if (error) throw error;

      const nextCustom = Array.isArray(primaryPayload.custom_services) ? primaryPayload.custom_services : (nextCustomServices || []);
      const nextVehicle = Array.isArray(primaryPayload.vehicle_types) && primaryPayload.vehicle_types.length
        ? primaryPayload.vehicle_types
        : normalizedVehicleTypes;

      setBusinessForm((prev) => ({
        ...prev,
        custom_services: nextCustom,
        vehicle_types: nextVehicle
      }));
      setPristine({
        ...businessForm,
        custom_services: nextCustom,
        vehicle_types: nextVehicle
      });
      await refreshConfig();
      setMessage({ type: 'success', text: successText });
    } catch (err) {
      console.error('Catalog save failed:', err);
      setMessage({ type: 'error', text: err.message || 'Failed to save service catalog changes.' });
    }
  };

  const isPublishServiceReady = () => {
    const name = String(newServiceForm.name || '').trim();
    const description = String(newServiceForm.description || '');
    const target = String(newServiceForm.targetVehicleCategory || '').trim();
    const price = Number(newServiceForm.price);
    const duration = Number(newServiceForm.duration);

    return Boolean(target)
      && name.length > 0
      && sanitizeBusinessHubValue('name', name) === name
      && sanitizeBusinessHubValue('description', description) === description
      && Number.isFinite(price)
      && price >= 0
      && Number.isFinite(duration)
      && duration > 0;
  };

  const handlePublishService = async () => {
    if (!isPublishServiceReady()) {
      setMessage({ type: 'error', text: 'Complete all service fields with valid values before publishing.' });
      return;
    }

    const name = sanitizeBusinessHubValue('name', newServiceForm.name).trim();
    const price = Number(newServiceForm.price);
    const duration = Number(newServiceForm.duration);

    const nextService = {
      id: `custom_${Date.now()}`,
      name,
      price,
      description: newServiceForm.description.trim() || 'Custom service added by the admin.',
      durationMinutes: duration,
      applicableVehicleTypes: [newServiceForm.targetVehicleCategory],
      vehicleTypes: [newServiceForm.targetVehicleCategory],
      vehicleType: newServiceForm.targetVehicleCategory,
      vehicle_type: newServiceForm.targetVehicleCategory,
      is_active: true,
      archived: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await saveCatalogState([...businessForm.custom_services, nextService], businessForm.vehicle_types, 'Service published successfully!');
    setNewServiceForm({ targetVehicleCategory: newServiceForm.targetVehicleCategory, name: '', price: '', duration: '60', description: '' });
    setServicePanels((prev) => ({ ...prev, add: false }));
  };

  const handleEditService = async () => {
    if (!editingService || !editingServiceForm) return;

    const name = editingServiceForm.name.trim();
    const price = Number(editingServiceForm.price);
    const duration = Number(editingServiceForm.duration);

    if (!name) {
      setMessage({ type: 'error', text: 'Service name is required.' });
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setMessage({ type: 'error', text: 'Price must be valid.' });
      return;
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      setMessage({ type: 'error', text: 'Duration must be greater than zero.' });
      return;
    }

    const nextServices = (businessForm.custom_services || []).map((service) =>
      service.id === editingService.id
        ? {
            ...service,
            name,
            price,
            description: editingServiceForm.description.trim() || 'Custom service updated by the admin.',
            durationMinutes: duration,
            applicableVehicleTypes: normalizeVehicleTypes({ applicableVehicleTypes: [service.vehicleType || service.vehicle_type || 'Sedan'] }),
            vehicleTypes: normalizeVehicleTypes({ applicableVehicleTypes: [service.vehicleType || service.vehicle_type || 'Sedan'] }),
            vehicleType: service.vehicleType || service.vehicle_type || 'Sedan',
            vehicle_type: service.vehicleType || service.vehicle_type || 'Sedan',
            updatedAt: new Date().toISOString(),
            is_active: service.is_active !== false && service.archived !== true,
            archived: false
          }
        : service
    );

    await saveCatalogState(nextServices, businessForm.vehicle_types, 'Service updated successfully!');
    setEditingService(null);
    setEditingServiceForm(null);
  };

  const handleArchiveRestoreService = async (service) => {
    const isArchived = service.is_active === false || service.archived === true;
    const nextServices = (businessForm.custom_services || []).map((entry) =>
      entry.id === service.id
        ? {
            ...entry,
            archived: !isArchived,
            is_active: isArchived,
            updatedAt: new Date().toISOString()
          }
        : entry
    );

    await saveCatalogState(nextServices, businessForm.vehicle_types, isArchived ? 'Service restored successfully!' : 'Service archived successfully!');
  };

  const isVehicleCategoryValid = () => {
    const categoryName = vehicleCategoryForm.name.trim();
    const serviceName = vehicleCategoryForm.serviceName.trim();
    const price = Number(vehicleCategoryForm.price);
    const duration = Number(vehicleCategoryForm.duration);
    return Boolean(categoryName) && Boolean(serviceName) && Number.isFinite(price) && price >= 0 && Number.isFinite(duration) && duration > 0;
  };

  const handleAddVehicleCategory = async () => {
    if (!isVehicleCategoryValid()) {
      setMessage({ type: 'error', text: 'Complete the vehicle category name and all initial service fields before saving.' });
      return;
    }

    const categoryName = vehicleCategoryForm.name.trim();
    const nextVehicleTypes = [...new Set([...(businessForm.vehicle_types || [...DEFAULT_VEHICLE_TYPES]), categoryName])];
    const initialService = {
      id: `custom_${Date.now()}`,
      name: vehicleCategoryForm.serviceName.trim(),
      price: Number(vehicleCategoryForm.price) || 0,
      description: vehicleCategoryForm.description.trim() || 'Initial service for the new vehicle category.',
      durationMinutes: Number(vehicleCategoryForm.duration) || 60,
      applicableVehicleTypes: [categoryName],
      vehicleTypes: [categoryName],
      vehicleType: categoryName,
      vehicle_type: categoryName,
      is_active: true,
      archived: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await saveCatalogState([...businessForm.custom_services, initialService], nextVehicleTypes, 'Vehicle category and service added successfully.');
    setVehicleCategoryForm({ name: '', serviceName: '', price: '', duration: '60', description: '' });
    setServicePanels((prev) => ({ ...prev, vehicle: false }));
  };

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
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.color = 'var(--admin-text-primary)';
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)';
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = isActive ? 'var(--admin-brand)' : 'var(--admin-text-secondary)';
                  e.currentTarget.style.background = 'transparent';
                }}
                onFocus={(e) => {
                  e.currentTarget.style.color = 'var(--admin-text-primary)';
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)';
                }}
                onBlur={(e) => {
                  e.currentTarget.style.color = isActive ? 'var(--admin-brand)' : 'var(--admin-text-secondary)';
                  e.currentTarget.style.background = 'transparent';
                }}
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
                  pointerEvents: 'auto',
                  position: 'relative',
                  zIndex: 1,
                  transition: 'color 0.2s ease, background 0.2s ease, border-color 0.2s ease, transform 0.2s ease',
                  transform: 'translateY(0)'
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
              <Field label="QR Photo">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', padding: '0.7rem 0.9rem', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-sm)', fontSize: '0.78rem', fontWeight: 800, color: 'var(--admin-text-secondary)' }}>
                  <span>{businessForm.payment_qr_url ? 'Image configured' : 'No image uploaded yet'}</span>
                  <button
                    type="button"
                    onClick={() => setShowQrModal(true)}
                    style={{ padding: '0.55rem 0.8rem', background: 'var(--admin-brand)', color: 'var(--admin-text-on-brand)', border: 'none', borderRadius: 'var(--admin-radius-sm)', fontWeight: 900, fontSize: '0.68rem', textTransform: 'uppercase', cursor: 'pointer' }}
                  >
                    Upload QR
                  </button>
                </div>
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

            <div style={{ ...insetPanelStyle, display: 'flex', flexDirection: 'column', gap: '0.85rem', marginTop: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: '0.82rem', fontWeight: 900, color: 'var(--admin-text-primary)', textTransform: 'uppercase', letterSpacing: '1px' }}>
                    FAQ Management
                  </h3>
                  <p style={{ margin: '0.35rem 0 0', fontSize: '0.7rem', color: 'var(--admin-text-secondary)', fontWeight: 700, lineHeight: 1.5 }}>
                    Manage landing-page questions here; saving the profile keeps the FAQ list in sync with the public storefront.
                  </p>
                </div>
                <span style={{ fontSize: '0.68rem', fontWeight: 800, color: 'var(--admin-text-secondary)' }}>
                  {visibleFaqs.length} {visibleFaqs.length === 1 ? 'entry' : 'entries'}
                </span>
              </div>

              {!faqEditorOpen && !editingFaqId && (
                <button
                  type="button"
                  onClick={() => setFaqEditorOpen(true)}
                  style={{ ...buttonBase, background: 'var(--admin-brand)', color: 'var(--admin-text-on-brand)', border: '1px solid var(--admin-brand)', alignSelf: 'flex-start' }}
                >
                  <Plus size={15} /> Add FAQ
                </button>
              )}

              {(faqEditorOpen || editingFaqId) && (
                <div style={{ ...insetPanelStyle, display: 'flex', flexDirection: 'column', gap: '0.75rem', background: 'var(--admin-card)' }}>
                  <input
                    type="text"
                    placeholder="Question"
                    value={faqForm.question}
                    onChange={(e) => setFaqForm((prev) => ({ ...prev, question: sanitizeBusinessHubValue('question', e.target.value) }))}
                    style={inputStyle}
                  />
                  <textarea
                    placeholder="Answer"
                    rows={3}
                    value={faqForm.answer}
                    onChange={(e) => setFaqForm((prev) => ({ ...prev, answer: sanitizeBusinessHubValue('answer', e.target.value) }))}
                    style={{ ...inputStyle, minHeight: '80px', resize: 'vertical', fontFamily: 'inherit' }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={addOrUpdateFaq}
                      style={{ ...buttonBase, background: 'var(--admin-brand)', color: 'var(--admin-text-on-brand)', border: '1px solid var(--admin-brand)' }}
                    >
                      {editingFaqId ? 'Update FAQ' : (<><Plus size={15} /> Save FAQ</>)}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setEditingFaqId(null); setFaqForm(EMPTY_NEW_FAQ); setFaqEditorOpen(false); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', background: 'transparent', border: 'none', color: 'var(--admin-text-secondary)', fontSize: '0.72rem', fontWeight: 800, cursor: 'pointer', padding: 0 }}
                    >
                      <X size={14} /> {editingFaqId ? 'Cancel edit' : 'Close'}
                    </button>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {visibleFaqs.length > 0 ? (
                  visibleFaqs.map((faq, index) => {
                    const isOpen = Boolean(faqPanels[faq.id]);

                    return (
                      <div key={faq.id} style={{ border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-sm)', background: 'var(--admin-bg)', overflow: 'hidden' }}>
                        <button
                          type="button"
                          onClick={() => setFaqPanels((prev) => ({ ...prev, [faq.id]: !prev[faq.id] }))}
                          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', background: 'transparent', border: 'none', color: 'var(--admin-text-primary)', padding: '0.9rem 1rem', fontWeight: 900, textAlign: 'left', cursor: 'pointer' }}
                        >
                          <span style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
                            <span style={{ fontSize: '0.7rem', color: 'var(--admin-text-secondary)', fontWeight: 800 }}>Q{index + 1}</span>
                            {faq.question}
                          </span>
                          {isOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                        </button>

                        {isOpen && (
                          <div style={{ borderTop: '1px solid var(--admin-border)', padding: '0.9rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                            <p style={{ margin: 0, fontSize: '0.72rem', color: 'var(--admin-text-secondary)', fontWeight: 700, lineHeight: 1.5 }}>
                              {faq.answer ? faq.answer : 'No answer added yet.'}
                            </p>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                              <button type="button" onClick={() => moveFaq(faq.id, -1)} disabled={index === 0 || faq.isStarter} title="Move up" style={{ ...ghostButton, opacity: index === 0 || faq.isStarter ? 0.4 : 1, cursor: index === 0 || faq.isStarter ? 'not-allowed' : 'pointer' }}>
                                <ChevronUp size={13} />
                              </button>
                              <button type="button" onClick={() => moveFaq(faq.id, 1)} disabled={index === visibleFaqs.length - 1 || faq.isStarter} title="Move down" style={{ ...ghostButton, opacity: index === visibleFaqs.length - 1 || faq.isStarter ? 0.4 : 1, cursor: index === visibleFaqs.length - 1 || faq.isStarter ? 'not-allowed' : 'pointer' }}>
                                <ChevronDown size={13} />
                              </button>
                              <button type="button" onClick={() => editFaq(faq)} style={ghostButton}>Edit answer</button>
                              {!faq.isStarter && (
                                <button type="button" onClick={() => removeFaq(faq.id)} style={{ ...ghostButton, color: 'var(--status-danger)', borderColor: 'rgba(239, 68, 68, 0.4)' }}>
                                  <Trash2 size={13} /> Delete
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div style={{ ...insetPanelStyle, fontSize: '0.74rem', color: 'var(--admin-text-secondary)', fontWeight: 600 }}>
                    No FAQs are available right now.
                  </div>
                )}
              </div>
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
              <Field label="Opening Time" required>
                <input
                  type="time"
                  value={formatTimeForInput(businessForm.opening_hour)}
                  onChange={(e) => handleInputChange('opening_hour', e.target.value)}
                  style={inputStyle}
                />
              </Field>
              <Field label="Closing Time" required>
                <input
                  type="time"
                  value={formatTimeForInput(businessForm.closing_hour)}
                  onChange={(e) => handleInputChange('closing_hour', e.target.value)}
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
              <Hint>Opening and closing times are required, closing must be after opening, and capacities must be at least 1.</Hint>
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
            <div style={{ display: 'grid', gap: '1.25rem' }}>
              <div
                style={{
                  border: '1px solid var(--admin-border)',
                  borderRadius: 'var(--admin-radius)',
                  background: 'var(--admin-card)',
                  padding: '1.2rem 1.25rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '1rem'
                }}
              >
                <div>
                  <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 900, color: 'var(--admin-text-primary)' }}>
                    General Schedule Rules
                  </h2>
                  <p style={{ margin: '0.35rem 0 0', fontSize: '0.74rem', color: 'var(--admin-text-secondary)', lineHeight: 1.5 }}>
                    Manage shop lead times and weekly closed days.
                  </p>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
                  <Field label="Minimum Advance Notice" required>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                      <input
                        type="number"
                        min="0"
                        max="43200"
                        step="15"
                        value={businessForm.booking_lead_time_minutes}
                        onChange={(e) => handleInputChange('booking_lead_time_minutes', e.target.value)}
                        style={{ ...inputStyle, flex: 1, minWidth: '120px' }}
                      />
                      <span style={{ fontSize: '0.72rem', color: 'var(--admin-text-secondary)', fontWeight: 700 }}>minutes</span>
                    </div>
                    <p style={{ margin: '0.38rem 0 0', fontSize: '0.68rem', color: 'var(--admin-text-secondary)', lineHeight: 1.5 }}>
                      How much notice do you need before a customer arrives? (e.g., 120 mins = 2 hours notice required).
                    </p>
                  </Field>

                  <Field label="Maximum Advance Booking Limit" required>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                      <input
                        type="number"
                        min="1"
                        max="365"
                        value={businessForm.max_advance_days}
                        onChange={(e) => handleInputChange('max_advance_days', e.target.value)}
                        style={{ ...inputStyle, flex: 1, minWidth: '120px' }}
                      />
                      <span style={{ fontSize: '0.72rem', color: 'var(--admin-text-secondary)', fontWeight: 700 }}>days</span>
                    </div>
                    <p style={{ margin: '0.38rem 0 0', fontSize: '0.68rem', color: 'var(--admin-text-secondary)', lineHeight: 1.5 }}>
                      How far into the future can customers schedule appointments? (e.g., 30 = up to 30 days ahead).
                    </p>
                  </Field>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
                  <div style={{ fontSize: '0.76rem', fontWeight: 800, color: 'var(--admin-text-primary)' }}>
                    Regular Weekly Schedule
                  </div>
                  <p style={{ margin: '0.2rem 0 0', fontSize: '0.7rem', color: 'var(--admin-text-secondary)', lineHeight: 1.5 }}>
                    Select which days your shop is open for customer appointments.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.6rem', width: '100%' }}>
                    {WEEKDAYS.map((day) => {
                      const isClosed = (businessForm.closed_weekdays || []).includes(day.value);
                      const statusText = isClosed ? 'Closed' : 'Open';
                      return (
                        <button
                          key={day.value}
                          type="button"
                          onClick={() => toggleClosedWeekday(day.value)}
                          aria-pressed={isClosed}
                          title={`${day.long} — ${statusText}`}
                          style={{
                            borderRadius: '0.75rem',
                            border: `1px solid ${isClosed ? 'rgba(244, 63, 94, 0.35)' : 'rgba(148, 163, 184, 0.28)'}`,
                            background: isClosed ? 'rgba(244, 63, 94, 0.09)' : 'rgba(15, 23, 42, 0.8)',
                            color: 'var(--admin-text-primary)',
                            padding: '0.7rem 0.45rem',
                            textAlign: 'center',
                            transition: 'all 0.2s ease',
                            cursor: 'pointer',
                            boxShadow: 'none',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '0.45rem',
                            minHeight: '74px'
                          }}
                        >
                          <span style={{ fontSize: '0.72rem', fontWeight: 900, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                            {day.short}
                          </span>
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              padding: '0.2rem 0.55rem',
                              borderRadius: '999px',
                              fontSize: '0.62rem',
                              fontWeight: 800,
                              letterSpacing: '0.04em',
                              textTransform: 'uppercase',
                              border: `1px solid ${isClosed ? 'rgba(244, 63, 94, 0.3)' : 'rgba(16, 185, 129, 0.35)'}`,
                              background: isClosed ? 'rgba(244, 63, 94, 0.12)' : 'rgba(16, 185, 129, 0.10)',
                              color: isClosed ? '#fda4af' : '#a7f3d0'
                            }}
                          >
                            {statusText}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {!sectionValid('schedule') && (
                  <Hint>Lead time must be 0–43,200 minutes and the advance window 1–365 days.</Hint>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '0.8rem', marginTop: '0.1rem', borderTop: '1px solid var(--admin-border)' }}>
                  <SaveBar
                    canSave={canSave('schedule')}
                    saving={saving}
                    dirty={isDirty('schedule')}
                    label="Save Schedule Rules"
                  />
                </div>
              </div>

              <div
                style={{
                  border: '1px solid var(--admin-border)',
                  borderRadius: 'var(--admin-radius)',
                  background: 'var(--admin-card)',
                  padding: '1.2rem 1.25rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '1rem'
                }}
              >
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 900, color: 'var(--admin-text-primary)' }}>
                    Holidays &amp; Special Shop Closures
                  </h3>
                  <p style={{ margin: '0.35rem 0 0', fontSize: '0.74rem', color: 'var(--admin-text-secondary)', lineHeight: 1.5 }}>
                    Set one-off closures for holidays, staff training, or shop maintenance.
                  </p>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
                  <div>
                    <label style={labelStyle}>Select Date</label>
                    <input
                      type="date"
                      value={restrictionDate}
                      onChange={(e) => setRestrictionDate(e.target.value)}
                      style={inputStyle}
                    />
                  </div>

                  <div>
                    <label style={labelStyle}>Closure Type</label>
                    <select
                      value={restrictionForm.scope}
                      onChange={(e) => setRestrictionForm((prev) => ({ ...prev, scope: e.target.value }))}
                      style={inputStyle}
                    >
                      <option value="day">Close Entire Day</option>
                      <option value="window">Block Specific Hours</option>
                      <option value="range">Close Multiple Days</option>
                    </select>
                  </div>

                  {restrictionForm.scope === 'range' && (
                    <>
                      <div>
                        <label style={labelStyle}>Start Date</label>
                        <input
                          type="date"
                          value={restrictionForm.startDate}
                          onChange={(e) => setRestrictionForm((prev) => ({ ...prev, startDate: e.target.value }))}
                          style={inputStyle}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>End Date</label>
                        <input
                          type="date"
                          value={restrictionForm.endDate}
                          onChange={(e) => setRestrictionForm((prev) => ({ ...prev, endDate: e.target.value }))}
                          style={inputStyle}
                        />
                      </div>
                    </>
                  )}

                  {restrictionForm.scope === 'window' && (
                    <>
                      <div>
                        <label style={labelStyle}>Start Time</label>
                        <SegmentedTimePicker
                          value={restrictionForm.startTime}
                          onChange={(value) => setRestrictionForm((prev) => ({ ...prev, startTime: value }))}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>End Time</label>
                        <SegmentedTimePicker
                          value={restrictionForm.endTime}
                          onChange={(value) => setRestrictionForm((prev) => ({ ...prev, endTime: value }))}
                        />
                      </div>
                    </>
                  )}

                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={labelStyle}>Reason</label>
                    <input
                      type="text"
                      value={restrictionForm.reason}
                      onChange={(e) => setRestrictionForm((prev) => ({ ...prev, reason: sanitizeBusinessHubValue('reason', e.target.value) }))}
                      placeholder="e.g., Holiday, Staff Training"
                      style={inputStyle}
                    />
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    onClick={handleCommitBlock}
                    style={{
                      ...buttonBase,
                      background: 'var(--admin-brand)',
                      color: '#fff',
                      border: '1px solid var(--admin-brand)',
                      cursor: 'pointer',
                      minWidth: '180px'
                    }}
                  >
                    + Add Shop Closure
                  </button>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', paddingTop: '0.7rem', borderTop: '1px solid var(--admin-border)' }}>
                  <div style={{ fontSize: '0.72rem', fontWeight: 900, color: 'var(--admin-text-secondary)', letterSpacing: '1px', textTransform: 'uppercase' }}>
                    Active Closures for {restrictionDate}
                  </div>

                  {blockedSlots.length === 0 ? (
                    <div style={{ fontSize: '0.78rem', color: 'var(--admin-text-secondary)', padding: '0.25rem 0' }}>
                      No active closures for this date.
                    </div>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr>
                            <th style={{ fontSize: '0.66rem', fontWeight: 800, color: 'var(--admin-text-secondary)', textAlign: 'left', padding: '0 0 0.55rem', borderBottom: '1px solid var(--admin-border)' }}>Date</th>
                            <th style={{ fontSize: '0.66rem', fontWeight: 800, color: 'var(--admin-text-secondary)', textAlign: 'left', padding: '0 0 0.55rem', borderBottom: '1px solid var(--admin-border)' }}>Type</th>
                            <th style={{ fontSize: '0.66rem', fontWeight: 800, color: 'var(--admin-text-secondary)', textAlign: 'left', padding: '0 0 0.55rem', borderBottom: '1px solid var(--admin-border)' }}>Reason</th>
                            <th style={{ fontSize: '0.66rem', fontWeight: 800, color: 'var(--admin-text-secondary)', textAlign: 'right', padding: '0 0 0.55rem', borderBottom: '1px solid var(--admin-border)' }}>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {blockedSlots.map((block) => (
                            <tr key={block.id}>
                              <td style={{ fontSize: '0.76rem', color: 'var(--admin-text-primary)', fontWeight: 800, padding: '0.7rem 0.4rem 0.7rem 0', borderBottom: '1px solid var(--admin-border)' }}>{restrictionDate}</td>
                              <td style={{ fontSize: '0.76rem', color: 'var(--admin-text-primary)', fontWeight: 700, padding: '0.7rem 0.4rem 0.7rem 0', borderBottom: '1px solid var(--admin-border)' }}>{block.start_time && block.end_time ? 'Specific Hours' : 'Entire Day'}</td>
                              <td style={{ fontSize: '0.76rem', color: 'var(--admin-text-secondary)', fontWeight: 700, padding: '0.7rem 0.4rem 0.7rem 0', borderBottom: '1px solid var(--admin-border)' }}>{block.reason || 'Shop closure'}</td>
                              <td style={{ padding: '0.7rem 0 0.7rem 0.4rem', borderBottom: '1px solid var(--admin-border)', textAlign: 'right' }}>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteBlock(block.id)}
                                  style={{ ...ghostButton, borderColor: 'var(--admin-brand)', color: 'var(--admin-brand)', background: 'rgba(var(--admin-brand-rgb, 230,30,42), 0.04)', justifyContent: 'center' }}
                                >
                                  Remove
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </form>
        )}

        {/* Tab 3: Service Catalog Configuration */}
        {currentTab === 'services' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {editingService && editingServiceForm && (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '1rem' }}>
                <div style={{ width: '100%', maxWidth: '560px', background: 'var(--admin-card)', borderRadius: 'var(--admin-radius)', border: '1px solid var(--admin-border)', boxShadow: 'var(--modal-shadow)', padding: '1.25rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem' }}>
                    <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 900, color: 'var(--admin-text-primary)' }}>Edit Service</h3>
                    <button type="button" onClick={() => { setEditingService(null); setEditingServiceForm(null); }} style={{ border: 'none', background: 'transparent', color: 'var(--admin-text-secondary)', cursor: 'pointer' }}>
                      <X size={18} />
                    </button>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
                    <div style={{ gridColumn: '1 / -1' }}>
                      <label style={labelStyle}>Service Name</label>
                      <input
                        type="text"
                        value={editingServiceForm.name}
                        onChange={(e) => setEditingServiceForm((prev) => ({ ...prev, name: sanitizeBusinessHubValue('name', e.target.value) }))}
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Price (₱)</label>
                      <input
                        type="text"
                        inputMode="decimal"
                        min="0"
                        value={editingServiceForm.price}
                        onChange={(e) => setEditingServiceForm((prev) => ({ ...prev, price: sanitizeNumericText(e.target.value, true) }))}
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Duration (Minutes)</label>
                      <input
                        type="text"
                        inputMode="numeric"
                        min="1"
                        value={editingServiceForm.duration}
                        onChange={(e) => setEditingServiceForm((prev) => ({ ...prev, duration: sanitizeNumericText(e.target.value, false) }))}
                        style={inputStyle}
                      />
                    </div>
                    <div style={{ gridColumn: '1 / -1' }}>
                      <label style={labelStyle}>Description</label>
                      <textarea
                        rows={4}
                        value={editingServiceForm.description}
                        onChange={(e) => setEditingServiceForm((prev) => ({ ...prev, description: sanitizeBusinessHubValue('description', e.target.value) }))}
                        style={{ ...inputStyle, resize: 'vertical', minHeight: '100px' }}
                      />
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1rem' }}>
                    <button type="button" onClick={() => { setEditingService(null); setEditingServiceForm(null); }} style={{ ...ghostButton, color: 'var(--admin-text-secondary)' }}>Cancel</button>
                    <button type="button" onClick={handleEditService} style={{ ...buttonBase, background: 'var(--admin-brand)', color: '#fff', border: '1px solid var(--admin-brand)' }}>Save Changes</button>
                  </div>
                </div>
              </div>
            )}

            <div style={{ ...cardStyle, gap: '1rem' }}>
              <button
                type="button"
                onClick={() => toggleServicePanel('existing')}
                style={{ width: '100%', background: 'transparent', border: 'none', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', color: 'var(--admin-text-primary)', textAlign: 'left' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
                  <span style={{ fontSize: '0.92rem', fontWeight: 900 }}>View &amp; Edit Existing Services</span>
                  <span style={{ fontSize: '0.68rem', fontWeight: 800, color: 'var(--admin-text-secondary)', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: '999px', padding: '0.3rem 0.55rem' }}>
                    {activeServices.length} active / {archivedServices.length} archived
                  </span>
                </div>
                {servicePanels.existing ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
              </button>

              {servicePanels.existing && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
                    <div>
                      <label style={labelStyle}>Select Vehicle</label>
                      <select
                        value={selectedVehicleFilter}
                        onChange={(e) => setSelectedVehicleFilter(e.target.value)}
                        style={inputStyle}
                      >
                        <option value="All">All Vehicles</option>
                        {getAvailableVehicleTypes().map((type) => (
                          <option key={type} value={type}>{getVehicleTypeLabel(type)}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '760px' }}>
                      <thead>
                        <tr>
                          <th style={{ ...{ fontSize: '0.66rem', fontWeight: 800, color: 'var(--admin-text-secondary)', textAlign: 'left', padding: '0.5rem 0.5rem 0.7rem', borderBottom: '1px solid var(--admin-border)' } }}>Service Name</th>
                          <th style={{ ...{ fontSize: '0.66rem', fontWeight: 800, color: 'var(--admin-text-secondary)', textAlign: 'left', padding: '0.5rem 0.5rem 0.7rem', borderBottom: '1px solid var(--admin-border)' } }}>Duration (Mins)</th>
                          <th style={{ ...{ fontSize: '0.66rem', fontWeight: 800, color: 'var(--admin-text-secondary)', textAlign: 'left', padding: '0.5rem 0.5rem 0.7rem', borderBottom: '1px solid var(--admin-border)' } }}>Price (₱)</th>
                          <th style={{ ...{ fontSize: '0.66rem', fontWeight: 800, color: 'var(--admin-text-secondary)', textAlign: 'left', padding: '0.5rem 0.5rem 0.7rem', borderBottom: '1px solid var(--admin-border)' } }}>Status</th>
                          <th style={{ ...{ fontSize: '0.66rem', fontWeight: 800, color: 'var(--admin-text-secondary)', textAlign: 'right', padding: '0.5rem 0.5rem 0.7rem', borderBottom: '1px solid var(--admin-border)' } }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredServices.length > 0 ? (
                          filteredServices.map((service) => (
                            <tr key={service.id}>
                              <td style={{ padding: '0.9rem 0.5rem', fontSize: '0.8rem', fontWeight: 900, color: 'var(--admin-text-primary)', borderBottom: '1px solid var(--admin-border)' }}>{service.name}</td>
                              <td style={{ padding: '0.9rem 0.5rem', fontSize: '0.76rem', color: 'var(--admin-text-secondary)', fontWeight: 700, borderBottom: '1px solid var(--admin-border)' }}>{Number(service.durationMinutes || 60)}</td>
                              <td style={{ padding: '0.9rem 0.5rem', fontSize: '0.78rem', color: 'var(--admin-text-primary)', fontWeight: 900, borderBottom: '1px solid var(--admin-border)' }}>₱{Number(service.price || 0).toLocaleString()}</td>
                              <td style={{ padding: '0.9rem 0.5rem', borderBottom: '1px solid var(--admin-border)' }}>
                                <span style={{ display: 'inline-flex', padding: '0.24rem 0.5rem', borderRadius: '999px', background: service.is_active === false || service.archived === true ? 'rgba(148, 163, 184, 0.12)' : 'rgba(16,185,129,0.12)', color: service.is_active === false || service.archived === true ? 'var(--admin-text-secondary)' : '#10b981', fontSize: '0.64rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                  {service.is_active === false || service.archived === true ? 'Archived' : 'Active'}
                                </span>
                              </td>
                              <td style={{ padding: '0.9rem 0.5rem', borderBottom: '1px solid var(--admin-border)', textAlign: 'right' }}>
                                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', flexWrap: 'wrap' }}>
                                  <button type="button" onClick={() => { setEditingService(service); setEditingServiceForm({ name: service.name || '', price: String(service.price ?? ''), duration: String(service.durationMinutes || 60), description: service.description || '' }); }} style={ghostButton}>Edit</button>
                                  <button type="button" onClick={() => handleArchiveRestoreService(service)} style={{ ...ghostButton, color: service.is_active === false || service.archived === true ? 'var(--admin-brand)' : 'var(--status-danger)', borderColor: service.is_active === false || service.archived === true ? 'var(--admin-border)' : 'rgba(239,68,68,0.4)' }}>
                                    {service.is_active === false || service.archived === true ? 'Restore' : 'Archive'}
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={5} style={{ padding: '1rem', textAlign: 'center', color: 'var(--admin-text-secondary)', fontWeight: 700, fontSize: '0.78rem' }}>
                              No services for this vehicle category.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            <div style={{ ...cardStyle, gap: '1rem' }}>
              <button
                type="button"
                onClick={() => toggleServicePanel('add')}
                style={{ width: '100%', background: 'transparent', border: 'none', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', color: 'var(--admin-text-primary)', textAlign: 'left' }}
              >
                <span style={{ fontSize: '0.92rem', fontWeight: 900 }}>+ Add New Service to Existing Vehicle</span>
                {servicePanels.add ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
              </button>

              {servicePanels.add && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
                  <div>
                    <label style={labelStyle}>Target Vehicle Category</label>
                    <select
                      value={newServiceForm.targetVehicleCategory}
                      onChange={(e) => setNewServiceForm((prev) => ({ ...prev, targetVehicleCategory: e.target.value }))}
                      style={inputStyle}
                    >
                      {getAvailableVehicleTypes().map((type) => (
                        <option key={type} value={type}>{type}</option>
                      ))}
                    </select>
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={labelStyle}>Service Name</label>
                    <input
                      type="text"
                      value={newServiceForm.name}
                      onChange={(e) => setNewServiceForm((prev) => ({ ...prev, name: sanitizeBusinessHubValue('name', e.target.value) }))}
                      placeholder="Premium Ceramic Wash"
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Price (₱)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      min="0"
                      value={newServiceForm.price}
                      onChange={(e) => setNewServiceForm((prev) => ({ ...prev, price: sanitizeNumericText(e.target.value, true) }))}
                      placeholder="2500"
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Estimated Duration (Minutes)</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      min="1"
                      value={newServiceForm.duration}
                      onChange={(e) => setNewServiceForm((prev) => ({ ...prev, duration: sanitizeNumericText(e.target.value, false) }))}
                      style={inputStyle}
                    />
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={labelStyle}>Description</label>
                    <textarea
                      rows={4}
                      value={newServiceForm.description}
                      onChange={(e) => setNewServiceForm((prev) => ({ ...prev, description: sanitizeBusinessHubValue('description', e.target.value) }))}
                      placeholder="Optional description"
                      style={{ ...inputStyle, minHeight: '100px', resize: 'vertical' }}
                    />
                  </div>
                  <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      onClick={handlePublishService}
                      disabled={!isPublishServiceReady()}
                      style={{
                        ...buttonBase,
                        background: isPublishServiceReady() ? 'var(--admin-brand)' : 'rgba(148, 163, 184, 0.25)',
                        color: isPublishServiceReady() ? '#fff' : 'var(--admin-text-secondary)',
                        border: `1px solid ${isPublishServiceReady() ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
                        cursor: isPublishServiceReady() ? 'pointer' : 'not-allowed',
                        opacity: isPublishServiceReady() ? 1 : 0.65,
                      }}
                    >
                      Publish Service
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div style={{ ...cardStyle, gap: '1rem' }}>
              <button
                type="button"
                onClick={() => toggleServicePanel('vehicle')}
                style={{ width: '100%', background: 'transparent', border: 'none', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', color: 'var(--admin-text-primary)', textAlign: 'left' }}
              >
                <span style={{ fontSize: '0.92rem', fontWeight: 900 }}>+ Add New Vehicle Category</span>
                {servicePanels.vehicle ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
              </button>

              {servicePanels.vehicle && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
                    <div style={{ gridColumn: '1 / -1' }}>
                      <label style={labelStyle}>Vehicle Category Name</label>
                      <input
                        type="text"
                        value={vehicleCategoryForm.name}
                        onChange={(e) => setVehicleCategoryForm((prev) => ({ ...prev, name: sanitizeBusinessHubValue('vehicleCategory', e.target.value) }))}
                        placeholder="e.g. Van / Minibus, Commercial Truck"
                        style={inputStyle}
                      />
                    </div>
                  </div>

                  <div style={{ ...insetPanelStyle, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <div>
                      <h4 style={{ margin: 0, fontSize: '0.78rem', fontWeight: 900, color: 'var(--admin-text-primary)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Initial Required Service</h4>
                      <p style={{ margin: '0.4rem 0 0', fontSize: '0.68rem', color: 'var(--admin-text-secondary)', fontWeight: 700, lineHeight: 1.5 }}>
                        Every vehicle category must have at least one active service before it can be saved and exposed to customers.
                      </p>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <label style={labelStyle}>Service Name</label>
                        <input
                          type="text"
                          value={vehicleCategoryForm.serviceName}
                          onChange={(e) => setVehicleCategoryForm((prev) => ({ ...prev, serviceName: sanitizeBusinessHubValue('serviceName', e.target.value) }))}
                          placeholder="Initial service name"
                          style={inputStyle}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Price (₱)</label>
                        <input
                          type="text"
                          inputMode="decimal"
                          min="0"
                          value={vehicleCategoryForm.price}
                          onChange={(e) => setVehicleCategoryForm((prev) => ({ ...prev, price: sanitizeNumericText(e.target.value, true) }))}
                          placeholder="1500"
                          style={inputStyle}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Duration (Mins)</label>
                        <input
                          type="text"
                          inputMode="numeric"
                          min="1"
                          value={vehicleCategoryForm.duration}
                          onChange={(e) => setVehicleCategoryForm((prev) => ({ ...prev, duration: sanitizeNumericText(e.target.value, false) }))}
                          style={inputStyle}
                        />
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <label style={labelStyle}>Description</label>
                        <textarea
                          rows={4}
                          value={vehicleCategoryForm.description}
                          onChange={(e) => setVehicleCategoryForm((prev) => ({ ...prev, description: sanitizeBusinessHubValue('description', e.target.value) }))}
                          placeholder="Optional description"
                          style={{ ...inputStyle, minHeight: '100px', resize: 'vertical' }}
                        />
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      disabled={!isVehicleCategoryValid()}
                      onClick={handleAddVehicleCategory}
                      style={{
                        ...buttonBase,
                        background: isVehicleCategoryValid() ? 'var(--admin-brand)' : 'var(--admin-input-bg, var(--admin-bg))',
                        color: isVehicleCategoryValid() ? '#fff' : 'var(--admin-text-secondary)',
                        border: `1px solid ${isVehicleCategoryValid() ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
                        cursor: isVehicleCategoryValid() ? 'pointer' : 'not-allowed',
                        opacity: isVehicleCategoryValid() ? 1 : 0.6
                      }}
                    >
                      Save Category &amp; Service
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab 5: Promo & Package Rules */}
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

      {/* Section 3.1: Delete confirmation. "Keep Editing" (Decline) preserves the
          form exactly as it was — the pending service is simply cleared. */}
      {pendingDelete && (
        <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, zIndex: 100000, background: 'var(--modal-overlay)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-lg, var(--admin-radius))', boxShadow: 'var(--modal-shadow)', width: '100%', maxWidth: '440px', padding: '1.5rem' }}>
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 950, color: 'var(--admin-text-primary)' }}>Delete Service?</h3>
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', fontWeight: 600, color: 'var(--admin-text-secondary)', lineHeight: 1.5 }}>
              You are about to delete <strong style={{ color: 'var(--admin-text-primary)' }}>{pendingDelete.name}</strong>. If it is linked to any past or active booking it will be archived instead, so booking history is preserved.
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={cancelDeleteService}
                style={{ flex: '1 1 130px', minHeight: '2.75rem', padding: '0.85rem 1rem', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-sm)', fontWeight: 950, fontSize: '0.78rem', textTransform: 'uppercase', cursor: 'pointer' }}
              >
                Keep Editing
              </button>
              <button
                type="button"
                onClick={confirmDeleteService}
                style={{ flex: '1 1 130px', minHeight: '2.75rem', padding: '0.85rem 1rem', background: 'var(--admin-brand)', color: 'var(--admin-text-on-brand)', border: 'none', borderRadius: 'var(--admin-radius-sm)', fontWeight: 950, fontSize: '0.78rem', textTransform: 'uppercase', cursor: 'pointer' }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
