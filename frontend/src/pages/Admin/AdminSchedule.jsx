import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { Calendar as CalendarIcon, ShieldAlert, Lock, Zap, CheckCircle2, RotateCw, ChevronDown, ChevronUp, ChevronRight, X, Check, Sliders } from 'lucide-react';
import PageHeader from '../../components/PageHeader';
import LoadingState from '../../components/LoadingState';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import toast from 'react-hot-toast';
import { logger } from '../../utils/logger';
import { getServiceCatalog, fetchActivePromos } from '../../data/servicesCatalog';

// Refactored Imports
import { COLORS } from '../../config/constants';
import { useConfig } from '../../context/ConfigContext';
import { segregateBookings } from '../../utils/schedulingUtils';
import SegmentedTimePicker from '../../components/AdminSchedule/SegmentedTimePicker';
import OccupancyShelf from '../../components/AdminSchedule/OccupancyShelf';
import DetailTimeline from '../../components/AdminSchedule/DetailTimeline';
import { AlertTriangle, Info } from 'lucide-react';

import { useUI } from '../../context/UIContext';
import { sendStatusEmail } from '../../services/notificationService';

const AdminSchedule = () => {
  const navigate = useNavigate();
  const { settings } = useConfig();
  const isMobile = useMediaQuery('(max-width: 1024px)');
  const { openModal, showToast } = useUI();

  // State: Navigation & Context
  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [viewDate, setViewDate] = useState(new Date());

  // State: Data
  const [bookings, setBookings] = useState([]);
  const [blockedSlots, setBlockedSlots] = useState([]);
  const [allMonthBookings, setAllMonthBookings] = useState([]);
  const [loading, setLoading] = useState(true);

  // State: Blocking Panel
  const hours = Array.from(
    { length: settings.CLOSING_HOUR - settings.OPENING_HOUR + 1 },
    (_, i) => i + settings.OPENING_HOUR
  );

  useEffect(() => {
    fetchMonthData();
  }, [viewDate]);

  useEffect(() => {
    fetchDailyContext();
    // 🛡️ REAL-TIME SYNCHRONIZATION (REQ-ADM-02)
    const channel = supabase.channel('admin-schedule-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, () => {
        fetchDailyContext();
        fetchMonthData();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'blocked_slots' }, () => {
        fetchDailyContext();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [selectedDate]);

  const fetchMonthData = async () => {
    try {
      const year = viewDate.getFullYear();
      const month = viewDate.getMonth() + 1;
      const firstDay = `${year}-${String(month).padStart(2, '0')}-01`;
      const nextMonthStart = new Date(Date.UTC(year, month, 1)).toISOString();

      const { data, error } = await supabase
        .from('bookings')
        .select('start_datetime')
        .gte('start_datetime', `${firstDay}T00:00:00Z`)
        .lt('start_datetime', nextMonthStart)
        .not('status', 'ilike', 'cancelled');

      if (error) throw error;
      setAllMonthBookings(data || []);
    } catch (err) {
      logger.error('Month Fetch Error', err);
    }
  };

  const fetchDailyContext = async () => {
    setLoading(true);
    try {
      await flagOverdueBookings();

      // 🛡️ 3-DAY BUFFER: Fetch yesterday, today, and tomorrow to capture any timezone shifts
      const d = new Date(selectedDate);
      const prev = new Date(d); prev.setDate(d.getDate() - 1);
      const next = new Date(d); next.setDate(d.getDate() + 1);

      const fetchStart = `${prev.toLocaleDateString('en-CA')}T00:00:00Z`;
      const fetchEnd = `${next.toLocaleDateString('en-CA')}T23:59:59Z`;

      const { data: bookingsRaw, error: bookingsError } = await supabase
        .from('bookings')
        .select(`
          *,
          customer:profiles!bookings_customer_id_fkey(full_name, email),
          vehicles:booking_vehicles!booking_vehicles_booking_id_fkey(*, services:booking_vehicle_services(service_name))
        `)
        .lte('start_datetime', fetchEnd)
        .gte('end_datetime', fetchStart)
        .not('status', 'ilike', 'cancelled');

      if (bookingsError) throw bookingsError;

      // 🛡️ MANUAL PROFILE RESOLUTION
      const bookingsData = [];
      if (bookingsRaw && bookingsRaw.length > 0) {
        for (const b of bookingsRaw) {
          if (!b.customer_id) {
            bookingsData.push({ ...b, customer: { full_name: b.customer_name || 'System/Guest User', email: b.customer_email || null } });
            continue;
          }

          const { data: profile } = await supabase
            .from('profiles')
            .select('full_name, email, phone_number')
            .eq('id', b.customer_id)
            .maybeSingle();
          bookingsData.push({ ...b, customer: profile || { full_name: b.customer_name || 'System/Guest User', email: b.customer_email || null } });
        }
      }

      const { data: blocksData, error: blocksError } = await supabase
        .from('blocked_slots')
        .select('*')
        .eq('block_date', selectedDate);

      if (blocksError) throw blocksError;

      setBookings(bookingsData || []);
      setBlockedSlots(blocksData || []);
    } catch (err) {
      logger.error('Daily Sync Error', err);
      toast.error('Failed to synchronize schedule');
    } finally {
      setLoading(false);
    }
  };

  const flagOverdueBookings = async () => {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: overdueBookings, error } = await supabase
      .from('bookings')
      .select('id')
      .in('status', ['scheduled', 'confirmed'])
      .lte('start_datetime', cutoff);

    if (error || !overdueBookings?.length) return;

    for (const overdue of overdueBookings) {
      const { error: updateError } = await supabase
        .from('bookings')
        .update({
          status: 'FLAGGED_NOSHOW',
          needs_attention: true,
          staff_id: null,
          bay_id: null,
          refund_status: 'QUEUED',
          updated_at: new Date().toISOString()
        })
        .eq('id', overdue.id)
        .in('status', ['scheduled', 'confirmed']);

      if (updateError) continue;

      await supabase.from('payments')
        .update({ status: 'REFUND_PENDING' })
        .eq('booking_id', overdue.id)
        .in('status', ['PAID', 'FOR_VERIFICATION']);

      await sendStatusEmail(overdue.id, 'FLAGGED_NOSHOW', 'No-show: service was not started within one hour of the scheduled time.');
    }
  };

  const handleDeleteBlock = (blockId, block) => {
    if (!blockId) return;
    openModal({
      title: 'Lift Schedule Restriction?',
      message: `Remove the ${block?.start_time ? 'time-window' : 'full-day'} restriction for ${selectedDate}?`,
      confirmText: 'Lift Restriction',
      cancelText: 'Keep Restriction',
      type: 'warning',
      onConfirm: async () => {
        const { error } = await supabase.from('blocked_slots').delete().eq('id', blockId);
        if (error) {
          logger.error('Restriction Delete Error', error);
          toast.error('Could not lift the schedule restriction.');
          return;
        }
        setBlockedSlots(current => current.filter(item => item.id !== blockId));
        toast.success('Schedule restriction lifted.');
      }
    });
  };

  const getBookingsForHour = (hour) => {
    const hourStart = new Date(`${selectedDate}T${String(hour).padStart(2, '0')}:00:00`);
    const hourEnd = new Date(`${selectedDate}T${String(hour + 1).padStart(2, '0')}:00:00`);

    return bookings.filter(b => {
      const bStart = new Date(b.start_datetime);
      const bEnd = new Date(b.end_datetime);
      return bEnd > hourStart && bStart < hourEnd;
    });
  };

  const getBlockForHour = (hour) => {
    return blockedSlots.find(block => {
      if (!block.start_time) return true; // NULL start_time = whole-day block
      const [sh] = block.start_time.split(':').map(Number);
      const [eh] = block.end_time.split(':').map(Number);
      return hour >= sh && hour < eh;
    });
  };

  const promoVehicleOptions = ['Sedan', 'SUV', 'Van/L300', 'Motorcycle Regular', 'Bigbike'];

  const getAvailableServicesForVehicle = (vehicleType) => {
    const catalog = getServiceCatalog();
    const result = [];
    Object.values(catalog).forEach(categoryServices => {
      categoryServices.forEach(service => {
        const prices = service.prices || {};
        let price = 0;
        if (vehicleType === 'Motorcycle Regular') {
          price = prices.Regular ?? prices['Motorcycle Regular'] ?? 0;
        } else if (vehicleType === 'Bigbike') {
          price = prices.Bigbike ?? 0;
        } else {
          price = prices[vehicleType] ?? 0;
        }
        if (Number(price) > 0) {
          result.push({
            id: service.id,
            name: service.name,
            price: Number(price)
          });
        }
      });
    });
    return result;
  };

  const defaultPromoRules = [
    {
      id: 'winter-wash',
      name: 'Winter Wash',
      mode: 'standard',
      type: 'percentage',
      value: 10,
      validFrom: '2026-09-21T00:00',
      validUntil: '2026-09-30T23:59',
      vehicleTypes: ['Sedan'],
      serviceMatches: ['Full Detail', 'Regular Wash'],
      vehicleServiceMatrix: {
        Sedan: ['Full Detail', 'Regular Wash']
      },
      isOngoing: true
    },
    {
      id: 'vip-detailing',
      name: 'VIP Detailing',
      mode: 'package',
      type: 'fixed_package',
      value: 500,
      validFrom: '2026-09-21T00:00',
      validUntil: '2026-09-30T23:59',
      vehicleTypes: ['SUV'],
      serviceMatches: ['Paint Correction', 'Supreme Wash'],
      vehicleServiceMatrix: {
        SUV: ['Paint Correction', 'Supreme Wash']
      },
      isOngoing: true
    }
  ];

  const [promoRules, setPromoRules] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('speedway_promo_rules') || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch {
      return defaultPromoRules;
    }
  });

  const defaultPromoDraft = {
    name: '',
    mode: 'standard', // 'standard' | 'package'
    type: 'percentage', // 'percentage' | 'fixed' | 'fixed_package'
    value: 10,
    validFrom: new Date().toISOString().slice(0, 16),
    validUntil: '',
    neverExpires: false,
    vehicleServiceMatrix: {
      Sedan: ['Supreme Wash', 'Regular Wash']
    }
  };

  const [promoDraft, setPromoDraft] = useState(defaultPromoDraft);
  const [promoValidationError, setPromoValidationError] = useState('');
  const [promoPublishing, setPromoPublishing] = useState(false);
  const [promoEditingId, setPromoEditingId] = useState(null);
  const [activeVehiclePopover, setActiveVehiclePopover] = useState(null);

  // Continuous promotion state evaluation ticker based on system/server time
  const [currentPromoTime, setCurrentPromoTime] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentPromoTime(new Date());
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    fetchActivePromos().then((rules) => {
      if (active && Array.isArray(rules)) syncPromoRules(rules);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  // Status Condition:
  // UPCOMING: Current Time < Start Time
  // ONGOING PROMO: Start Time <= Current Time <= End Time
  // EXPIRED: Current Time > End Time
  const getPromoStatus = (rule) => {
    if (!rule) return 'EXPIRED';
    const now = currentPromoTime.getTime();
    const start = rule.validFrom ? new Date(rule.validFrom).getTime() : NaN;
    const isNever = rule.neverExpires === true || rule.validUntil === 'never';
    const end = isNever ? Infinity : (rule.validUntil ? new Date(rule.validUntil).getTime() : NaN);

    if (!isNaN(start) && now < start) {
      return 'UPCOMING';
    }
    if (!isNaN(end) && now > end) {
      return 'EXPIRED';
    }
    return 'ONGOING PROMO';
  };

  const formatPromoDate = (isoDate) => {
    if (!isoDate) return '—';
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) return isoDate;
    return date.toLocaleString('en-PH', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  };

  const syncPromoRules = (nextRules) => {
    setPromoRules(nextRules);
    localStorage.setItem('speedway_promo_rules', JSON.stringify(nextRules));
  };

  const resetPromoDraft = () => {
    setPromoDraft(defaultPromoDraft);
    setPromoEditingId(null);
    setPromoValidationError('');
    setActiveVehiclePopover(null);
  };

  // Interactive Target Binding Helpers
  const toggleVehicleScope = (vehicle) => {
    setPromoDraft(prev => {
      const matrix = { ...(prev.vehicleServiceMatrix || {}) };
      if (matrix[vehicle]) {
        delete matrix[vehicle];
        if (activeVehiclePopover === vehicle) {
          setActiveVehiclePopover(null);
        }
      } else {
        const avail = getAvailableServicesForVehicle(vehicle).map(s => s.name);
        matrix[vehicle] = avail;
        setActiveVehiclePopover(vehicle);
      }
      return { ...prev, vehicleServiceMatrix: matrix };
    });
    setPromoValidationError('');
  };

  const toggleServiceForVehicle = (vehicle, serviceName) => {
    setPromoDraft(prev => {
      const matrix = { ...(prev.vehicleServiceMatrix || {}) };
      const currentServices = new Set(matrix[vehicle] || []);
      if (currentServices.has(serviceName)) {
        currentServices.delete(serviceName);
      } else {
        currentServices.add(serviceName);
      }
      matrix[vehicle] = Array.from(currentServices);
      return { ...prev, vehicleServiceMatrix: matrix };
    });
    setPromoValidationError('');
  };

  const setAllServicesForVehicle = (vehicle, mode) => {
    setPromoDraft(prev => {
      const matrix = { ...(prev.vehicleServiceMatrix || {}) };
      if (mode === 'all') {
        const avail = getAvailableServicesForVehicle(vehicle).map(s => s.name);
        matrix[vehicle] = avail;
      } else {
        matrix[vehicle] = [];
      }
      return { ...prev, vehicleServiceMatrix: matrix };
    });
    setPromoValidationError('');
  };

  // Confirmation Lock Engine: Evaluates pre-conditions
  const hasValidVehicleServiceMapping = Object.values(promoDraft.vehicleServiceMatrix || {}).some(
    services => Array.isArray(services) && services.length > 0
  );

  const isDatesValid = Boolean(
    promoDraft.validFrom &&
    (promoDraft.neverExpires || (promoDraft.validUntil && new Date(promoDraft.validUntil) > new Date(promoDraft.validFrom)))
  );

  const isConfirmUnlocked = Boolean(
    promoDraft.name.trim() &&
    Number(promoDraft.value) > 0 &&
    isDatesValid &&
    hasValidVehicleServiceMapping
  );

  const handleCommitPromo = async () => {
    // Intercept and reject any direct API put/patch edit requests originating from client side for active or expired promo IDs
    if (promoEditingId) {
      const existing = promoRules.find(r => r.id === promoEditingId);
      if (existing) {
        const existingStatus = getPromoStatus(existing);
        if (existingStatus === 'ONGOING PROMO') {
          const msg = 'Active promotions cannot be edited while ongoing. Deactivate or wait for expiry.';
          setPromoValidationError(msg);
          toast.error(msg);
          return;
        }
        if (existingStatus === 'EXPIRED') {
          const msg = 'Expired promotions cannot transition back into an editable state.';
          setPromoValidationError(msg);
          toast.error(msg);
          return;
        }
      }
    }

    if (!promoDraft.name.trim()) {
      setPromoValidationError('Please enter a promo name.');
      return;
    }
    if (!promoDraft.value || Number(promoDraft.value) <= 0) {
      setPromoValidationError('Please enter a valid discount value or package price.');
      return;
    }
    if (!promoDraft.validFrom || (!promoDraft.neverExpires && !promoDraft.validUntil)) {
      setPromoValidationError('Please set valid dates.');
      return;
    }
    if (!promoDraft.neverExpires && new Date(promoDraft.validUntil) <= new Date(promoDraft.validFrom)) {
      setPromoValidationError('Valid Until must be later than Valid From.');
      return;
    }

    const boundVehicles = Object.keys(promoDraft.vehicleServiceMatrix || {}).filter(
      v => Array.isArray(promoDraft.vehicleServiceMatrix[v]) && promoDraft.vehicleServiceMatrix[v].length > 0
    );
    if (!boundVehicles.length) {
      setPromoValidationError('Please select at least 1 vehicle type and bind applicable services.');
      return;
    }

    setPromoPublishing(true);
    setPromoValidationError('');

    const nextRule = {
      id: promoEditingId || `promo-${Date.now()}`,
      name: promoDraft.name.trim(),
      mode: promoDraft.mode || 'standard',
      type: promoDraft.mode === 'package' ? 'fixed_package' : promoDraft.type,
      value: Number(promoDraft.value),
      validFrom: promoDraft.validFrom,
      validUntil: promoDraft.neverExpires ? 'never' : promoDraft.validUntil,
      neverExpires: Boolean(promoDraft.neverExpires),
      vehicleServiceMatrix: promoDraft.vehicleServiceMatrix,
      vehicleTypes: boundVehicles,
      serviceMatches: Array.from(new Set(Object.values(promoDraft.vehicleServiceMatrix).flat())),
      isOngoing: true
    };

    try {
      const BACKEND_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_BACKEND_URL) || window.location.origin;
      const session = (await supabase.auth.getSession()).data.session;
      const response = await fetch(`${BACKEND_URL}/api/admin/promos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
        body: JSON.stringify(nextRule)
      });

      if (response.ok) {
        const result = await response.json();
        if (result.promoRules) {
          syncPromoRules(result.promoRules);
        } else {
          const nextRules = promoEditingId
            ? promoRules.map(rule => rule.id === promoEditingId ? nextRule : rule)
            : [nextRule, ...promoRules];
          syncPromoRules(nextRules);
        }
      } else {
        const errJson = await response.json().catch(() => ({}));
        if (errJson.error) {
          toast.error(errJson.error);
          setPromoValidationError(errJson.error);
          setPromoPublishing(false);
          return;
        }
        toast.error(errJson.error || 'The promotion could not be saved.');
        setPromoValidationError(errJson.error || 'The promotion could not be saved.');
        setPromoPublishing(false);
        return;
      }
    } catch (error) {
      logger.error('Promo publish failed; promotion was not saved.', error);
      toast.error('The promotions service is unreachable. The promotion was not saved.');
      setPromoValidationError('The promotions service is unreachable. The promotion was not saved.');
      setPromoPublishing(false);
      return;
    }

    toast.success(
      promoEditingId
        ? `Promo "${nextRule.name}" updated successfully!`
        : promoDraft.mode === 'package'
          ? `Package Promo "${nextRule.name}" confirmed successfully!`
          : `Promo "${nextRule.name}" created successfully!`
    );
    resetPromoDraft();
    setPromoPublishing(false);
  };

  const handleEditPromo = (rule) => {
    const status = getPromoStatus(rule);
    // Immutability Enforcement: Active and expired promotions cannot be edited
    if (status === 'ONGOING PROMO') {
      toast.error('Active promotions cannot be edited while ongoing. Deactivate or wait for expiry.');
      return;
    }
    if (status === 'EXPIRED') {
      toast.error('Expired promotions cannot transition back into an editable state.');
      return;
    }
    setPromoEditingId(rule.id);

    // Reconstruct vehicleServiceMatrix if legacy format
    let matrix = rule.vehicleServiceMatrix;
    if (!matrix || typeof matrix !== 'object' || !Object.keys(matrix).length) {
      matrix = {};
      const vTypes = Array.isArray(rule.vehicleTypes) && rule.vehicleTypes.length ? rule.vehicleTypes : ['Sedan'];
      const sMatches = Array.isArray(rule.serviceMatches) ? rule.serviceMatches : [];
      vTypes.forEach(v => {
        matrix[v] = [...sMatches];
      });
    }

    setPromoDraft({
      name: rule.name || '',
      mode: rule.mode || (rule.type === 'fixed_package' ? 'package' : 'standard'),
      type: rule.type || 'percentage',
      value: rule.value || 0,
      validFrom: rule.validFrom || '',
      validUntil: rule.neverExpires ? '' : (rule.validUntil || ''),
      vehicleServiceMatrix: matrix,
      neverExpires: Boolean(rule.neverExpires)
    });
    setPromoValidationError('');
    setActiveVehiclePopover(Object.keys(matrix)[0] || null);
  };

  const handleRemovePromo = (promoId) => {
    const target = promoRules.find(rule => rule.id === promoId);
    if (!target) return;

    openModal({
      title: 'Remove Promo Campaign?',
      message: `Remove "${target.name}" from the active campaign list? If currently active, this immediately revokes its application across all uncommitted cart checkout sessions.`,
      confirmText: 'Delete Promo',
      cancelText: 'Cancel',
      type: 'danger',
      onConfirm: async () => {
        if (promoEditingId === promoId) {
          resetPromoDraft();
        }
        const session = (await supabase.auth.getSession()).data.session;
        const response = await fetch(`${(typeof import.meta !== 'undefined' && import.meta.env?.VITE_BACKEND_URL) || window.location.origin}/api/admin/promos/${encodeURIComponent(promoId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${session?.access_token || ''}` }
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.success) {
          toast.error(result.error || 'The promotion could not be removed.');
          return;
        }
        const nextRules = result.promoRules || promoRules.filter(rule => rule.id !== promoId);
        syncPromoRules(nextRules);
        toast.success(`Promo "${target.name}" removed.`);
      }
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingBottom: '2rem', maxWidth: '1600px', margin: '0 auto' }}>
      <PageHeader
        badge="STUDIO"
        title="STUDIO CALENDAR"
        subtitle="Track bay utilization and live service flow."
        onRefresh={fetchDailyContext}
      >
        <button
          onClick={() => { fetchDailyContext(); fetchMonthData(); }}
          title="Refresh schedule data"
          style={{ background: 'transparent', border: '1px solid var(--admin-border)', color: 'var(--admin-text-secondary)', padding: '0.6rem', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <RotateCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </PageHeader>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '350px 1fr', gap: '2rem', alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: '4px', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.25rem', borderBottom: '1px solid var(--admin-border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <CalendarIcon size={18} color="var(--admin-brand)" />
                <span style={{ fontWeight: '950', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '1px' }}>
                  {viewDate.toLocaleString('default', { month: 'long' })} {viewDate.getFullYear()}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  onClick={() => { const d = new Date(viewDate); d.setMonth(d.getMonth() - 1); setViewDate(d); }}
                  style={{ background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', color: 'var(--admin-text-primary)', padding: '0.25rem 0.6rem', borderRadius: '4px', cursor: 'pointer' }}
                >&lsaquo;</button>
                <button
                  onClick={() => { const d = new Date(viewDate); d.setMonth(d.getMonth() + 1); setViewDate(d); }}
                  style={{ background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', color: 'var(--admin-text-primary)', padding: '0.25rem 0.6rem', borderRadius: '4px', cursor: 'pointer' }}
                >&rsaquo;</button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', background: 'rgba(0,0,0,0.2)' }}>
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                <div key={i} style={{ textAlign: 'center', fontSize: '0.6rem', fontWeight: '950', color: 'var(--admin-text-secondary)', padding: '0.75rem 0' }}>{d}</div>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '1px', background: 'var(--admin-border)' }}>
              {(() => {
                const today = new Date().toLocaleDateString('en-CA');
                const year = viewDate.getFullYear();
                const month = viewDate.getMonth();
                const firstDay = new Date(year, month, 1).getDay();
                const daysInMonth = new Date(year, month + 1, 0).getDate();
                const cells = [];

                for (let i = 0; i < firstDay; i++) cells.push(<div key={`empty-${i}`} style={{ background: 'var(--admin-card)', height: '50px' }} />);

                for (let day = 1; day <= daysInMonth; day++) {
                  const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                  const isToday = dateStr === today;
                  const isSelected = dateStr === selectedDate;
                  const hasBookings = allMonthBookings.some(b => {
                    const d = new Date(b.start_datetime);
                    const bDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                    return bDate === dateStr;
                  });

                  cells.push(
                    <div
                      key={dateStr}
                      onClick={() => {
                        setSelectedDate(dateStr);
                        if (new Date(dateStr).getMonth() !== viewDate.getMonth()) setViewDate(new Date(dateStr));
                      }}
                      style={{
                        background: isSelected ? 'rgba(255,255,255,0.05)' : 'var(--admin-card)',
                        height: '50px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        fontSize: '0.85rem',
                        fontWeight: '900',
                        color: isSelected || isToday ? 'var(--admin-text-primary)' : 'var(--admin-text-secondary)',
                        position: 'relative',
                        border: isSelected ? '2px solid var(--admin-brand)' : isToday ? '1px solid rgba(230,30,42,0.4)' : 'none'
                      }}
                    >
                      {day}
                      {hasBookings && (
                        <div style={{ position: 'absolute', bottom: '8px', width: '4px', height: '4px', borderRadius: '50%', background: 'var(--admin-brand)' }} />
                      )}
                    </div>
                  );
                }
                return cells;
              })()}
            </div>
          </div>

          <div style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: '4px', padding: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem', borderBottom: '1px solid var(--admin-border)', paddingBottom: '0.75rem' }}>
              <ShieldAlert size={16} color="var(--admin-brand)" />
              <h4 style={{ margin: 0, fontSize: '0.7rem', fontWeight: '950', textTransform: 'uppercase', letterSpacing: '1px' }}>Active Restrictions</h4>
            </div>
            {blockedSlots.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {blockedSlots.map(block => (
                  <div key={block.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(230,30,42,0.05)', padding: '0.75rem', borderRadius: '4px', border: '1px solid rgba(230,30,42,0.1)' }}>
                    <div>
                      <p style={{ margin: 0, fontSize: '0.75rem', fontWeight: '950', color: 'var(--admin-text-primary)' }}>{block.reason || 'MAINTENANCE'}</p>
                      <p style={{ margin: 0, fontSize: '0.6rem', color: 'var(--admin-text-secondary)', fontWeight: '700' }}>
                        {block.start_time ? `${block.start_time} - ${block.end_time}` : 'FULL DAY BLOCK'}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ margin: '1rem 0', textAlign: 'center', fontSize: '0.65rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', opacity: 0.5 }}>No Active Blocks</p>
            )}
          </div>

        </div>

        <div style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: '4px', overflow: 'hidden' }}>
          <div style={{ padding: '1.5rem' }}>
            <OccupancyShelf
              bookings={bookings}
              onBookingClick={(id) => navigate(`/admin/bookings/${id}`)}
              config={settings}
            />

            {loading ? <LoadingState message="Syncing timeline..." /> : (
              <>
                {bookings.length === 0 && blockedSlots.length === 0 && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '1rem',
                    padding: '0.85rem 1.25rem',
                    background: 'rgba(16, 185, 129, 0.05)',
                    border: '1px solid rgba(16, 185, 129, 0.2)',
                    borderRadius: '6px',
                    marginBottom: '1rem'
                  }}>
                    <CheckCircle2 size={18} color="var(--status-success)" style={{ flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: '950', color: 'var(--status-success)', textTransform: 'uppercase', letterSpacing: '1px' }}>Zero Administrative Records</span>
                      <span style={{ fontSize: '0.7rem', color: 'var(--admin-text-secondary)', fontWeight: '600', marginLeft: '0.75rem' }}>This day is clear. No bookings or restrictions are scheduled.</span>
                    </div>
                  </div>
                )}
                <DetailTimeline
                  hours={hours}
                  selectedDate={selectedDate}
                  getBookingsForHour={getBookingsForHour}
                  getBlockForHour={getBlockForHour}
                  onBookingClick={(id) => navigate(`/admin/bookings/${id}`)}
                  onDeleteBlock={handleDeleteBlock}
                  config={settings}
                />
              </>
            )}
          </div>
        </div>
      </div>

    </div>
  );
};

export default AdminSchedule;
