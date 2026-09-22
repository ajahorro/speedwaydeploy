import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { Calendar as CalendarIcon, ShieldAlert, Lock, Zap, CheckCircle2, RotateCw, Tag, Layers, ChevronDown, ChevronUp, ChevronRight, X, Check, Sliders } from 'lucide-react';
import PageHeader from '../../components/PageHeader';
import LoadingState from '../../components/LoadingState';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import toast from 'react-hot-toast';
import { logger } from '../../utils/logger';
import { getServiceCatalog } from '../../data/servicesCatalog';

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
  const [isAddingBlock, setIsAddingBlock] = useState(false);
  const [blockData, setBlockData] = useState({
    scope: 'day', // 'day', 'window', 'range'
    startDate: selectedDate,
    endDate: selectedDate,
    startTime: `${String(settings.OPENING_HOUR).padStart(2, '0')}:00`,
    endTime: `${String(settings.CLOSING_HOUR - 4).padStart(2, '0')}:00`,
    reason: '',
    isWholeDay: true
  });

  const hours = Array.from(
    { length: settings.CLOSING_HOUR - settings.OPENING_HOUR + 1 },
    (_, i) => i + settings.OPENING_HOUR
  );

  useEffect(() => {
    fetchMonthData();
  }, [viewDate]);

  useEffect(() => {
    fetchDailyContext();
    setBlockData(prev => ({ ...prev, startDate: selectedDate, endDate: selectedDate }));

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

  const handleCommitBlock = async () => {
    let payload = {};
    let confirmMsg = '';

    if (blockData.scope === 'range') {
      if (!blockData.startDate || !blockData.endDate) {
        toast.error('Please specify both Start Date and End Date');
        return;
      }
      if (blockData.startDate > blockData.endDate) {
        toast.error('Start Date cannot be after End Date');
        return;
      }
      payload = {
        start_date: blockData.startDate,
        end_date: blockData.endDate,
        start_time: blockData.isWholeDay ? null : blockData.startTime,
        end_time: blockData.isWholeDay ? null : blockData.endTime,
        reason: blockData.reason || 'MULTI-DAY BLOCK'
      };
      confirmMsg = `Are you sure you want to block resource bays from ${blockData.startDate} to ${blockData.endDate}?`;
    } else {
      const isWindow = blockData.scope === 'window';
      payload = {
        block_date: selectedDate,
        start_time: isWindow ? blockData.startTime : null,
        end_time: isWindow ? blockData.endTime : null,
        reason: blockData.reason || (isWindow ? 'TIME WINDOW RESTRICTION' : 'FULL DAY BLOCK')
      };
      confirmMsg = `Are you sure you want to block ${isWindow ? `time window ${blockData.startTime} - ${blockData.endTime}` : 'the full working day'} on ${selectedDate}?`;
    }

    openModal({
      title: "Confirm Schedule Restriction",
      message: confirmMsg,
      confirmText: "Commit Restriction",
      type: "danger",
      onConfirm: async () => {
        try {
          const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';
          const res = await fetch(`${BACKEND_URL}/api/admin/blocked-slots`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          const resData = await res.json().catch(() => ({}));
          if (!res.ok || !resData.success) {
            const conflictIds = (resData.bookings || []).map(booking => `#${booking.id.substring(0, 8).toUpperCase()}`).join(', ');
            throw new Error(conflictIds ? `${resData.error} Affected bookings: ${conflictIds}.` : (resData.error || 'Failed to commit restriction'));
          }

          showToast('Schedule restriction committed', 'success');
          setIsAddingBlock(false);
          fetchDailyContext();
          fetchMonthData();
        } catch (err) {
          logger.error('Block Error', err);
          showToast(err.message || 'Failed to commit restriction', 'error');
        }
      }
    });
  };

  const handleDeleteBlock = async (id, targetBlock = null) => {
    const isFullDay = targetBlock ? !targetBlock.start_time : false;
    const timeDesc = targetBlock
      ? (isFullDay ? 'Full Day Restriction' : `Time Window ${targetBlock.start_time} - ${targetBlock.end_time}`)
      : 'this restriction';

    openModal({
      title: "Lift Schedule Restriction",
      message: `Are you sure you want to lift ${timeDesc}? This will reopen resource bays for booking.`,
      confirmText: "Lift Restriction",
      type: "brand",
      onConfirm: async () => {
        // 1. Snapshot current state for rollback
        const snapshot = blockedSlots;
        // 2. Optimistic remove immediately
        setBlockedSlots(prev => prev.filter(b => b.id !== id));
        try {
          const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';
          const res = await fetch(`${BACKEND_URL}/api/admin/blocked-slots/${id}`, {
            method: 'DELETE'
          });

          if (!res.ok) throw new Error('Failed to delete block');

          showToast('Restriction lifted', 'success');
          fetchDailyContext();
          fetchMonthData();
        } catch (err) {
          logger.error('Block delete error', err);
          showToast('Failed to lift restriction', 'error');
          // 3. Rollback on failure
          setBlockedSlots(snapshot);
        }
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
      return Array.isArray(saved) && saved.length ? saved : defaultPromoRules;
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
      const BACKEND_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_BACKEND_URL) || 'http://localhost:3000';
      const response = await fetch(`${BACKEND_URL}/api/admin/promos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        const nextRules = promoEditingId
          ? promoRules.map(rule => rule.id === promoEditingId ? nextRule : rule)
          : [nextRule, ...promoRules];
        syncPromoRules(nextRules);
      }
    } catch {
      const nextRules = promoEditingId
        ? promoRules.map(rule => rule.id === promoEditingId ? nextRule : rule)
        : [nextRule, ...promoRules];
      syncPromoRules(nextRules);
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
      onConfirm: () => {
        if (promoEditingId === promoId) {
          resetPromoDraft();
        }
        const nextRules = promoRules.filter(rule => rule.id !== promoId);
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
                    <button
                      onClick={() => handleDeleteBlock(block.id)}
                      style={{ background: 'none', border: '1px solid rgba(230,30,42,0.3)', color: 'var(--admin-brand)', fontSize: '0.55rem', fontWeight: '950', padding: '0.25rem 0.5rem', borderRadius: '2px', cursor: 'pointer', textTransform: 'uppercase' }}
                    >Lift</button>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ margin: '1rem 0', textAlign: 'center', fontSize: '0.65rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', opacity: 0.5 }}>No Active Blocks</p>
            )}
          </div>

          <button
            onClick={() => setIsAddingBlock(!isAddingBlock)}
            style={{ width: '100%', padding: '1rem', background: isAddingBlock ? 'rgba(230, 30, 42, 0.1)' : 'var(--admin-card)', color: isAddingBlock ? 'var(--admin-brand)' : 'var(--admin-text-primary)', border: `1px solid ${isAddingBlock ? 'var(--admin-brand)' : 'var(--admin-border)'}`, borderRadius: '8px', fontWeight: '950', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem' }}
          >
            {isAddingBlock ? <Zap size={18} /> : <Lock size={18} />}
            {isAddingBlock ? 'Cancel Restriction' : 'Restrict Resources'}
          </button>
        </div>

        <div style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: '4px', overflow: 'hidden' }}>
          {isAddingBlock && (
            <div style={{ padding: '1.25rem', background: 'rgba(230, 30, 42, 0.05)', borderBottom: '1px solid var(--admin-border)' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.5rem', alignItems: 'flex-end' }}>
                <div style={{ flex: '0 0 220px' }}>
                  <label style={{ fontSize: '0.6rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '0.6rem', display: 'block' }}>Restriction Scope</label>
                  <select
                    value={blockData.scope}
                    onChange={(e) => {
                      const s = e.target.value;
                      setBlockData(prev => ({
                        ...prev,
                        scope: s,
                        isWholeDay: s !== 'window'
                      }));
                    }}
                    style={{ width: '100%', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', color: 'var(--admin-text-primary)', padding: '0.85rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: '900', outline: 'none' }}
                  >
                    <option value="day">Full Working Day (Single Date)</option>
                    <option value="window">Specific Time Frame (Single Date)</option>
                    <option value="range">Multi-Day Date Range</option>
                  </select>
                </div>

                {blockData.scope === 'range' && (
                  <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                    <div>
                      <label style={{ fontSize: '0.6rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '0.6rem', display: 'block' }}>Start Date</label>
                      <input
                        type="date"
                        value={blockData.startDate}
                        onChange={(e) => setBlockData({ ...blockData, startDate: e.target.value })}
                        style={{ background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', color: 'var(--admin-text-primary)', padding: '0.75rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: '900', outline: 'none' }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: '0.6rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '0.6rem', display: 'block' }}>End Date</label>
                      <input
                        type="date"
                        value={blockData.endDate}
                        onChange={(e) => setBlockData({ ...blockData, endDate: e.target.value })}
                        style={{ background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', color: 'var(--admin-text-primary)', padding: '0.75rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: '900', outline: 'none' }}
                      />
                    </div>
                  </div>
                )}

                {blockData.scope === 'window' && (
                  <div style={{ display: 'flex', gap: '1rem' }}>
                    <div>
                      <label style={{ fontSize: '0.6rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '0.6rem', display: 'block' }}>Start</label>
                      <SegmentedTimePicker value={blockData.startTime} onChange={(v) => setBlockData({ ...blockData, startTime: v })} />
                    </div>
                    <div>
                      <label style={{ fontSize: '0.6rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '0.6rem', display: 'block' }}>End</label>
                      <SegmentedTimePicker value={blockData.endTime} onChange={(v) => setBlockData({ ...blockData, endTime: v })} />
                    </div>
                  </div>
                )}

                <div style={{ flex: 1, minWidth: '200px' }}>
                  <label style={{ fontSize: '0.6rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '0.6rem', display: 'block' }}>Rationale / Reason</label>
                  <input
                    type="text"
                    placeholder="e.g., Shop Maintenance, Staff Holiday..."
                    value={blockData.reason}
                    onChange={(e) => setBlockData({ ...blockData, reason: e.target.value })}
                    style={{ width: '100%', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', color: 'var(--admin-text-primary)', padding: '0.85rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: '900', outline: 'none' }}
                  />
                </div>

                <button
                  onClick={handleCommitBlock}
                  style={{ background: 'var(--admin-brand)', color: 'var(--admin-text-primary)', border: 'none', padding: '0.85rem 2rem', borderRadius: '4px', fontWeight: '950', fontSize: '0.75rem', textTransform: 'uppercase', cursor: 'pointer', letterSpacing: '1px' }}
                >
                  Commit Block
                </button>
              </div>
            </div>
          )}

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
                    <button
                      onClick={() => setIsAddingBlock(true)}
                      style={{
                        padding: '0.5rem 1rem', background: 'transparent',
                        border: '1px solid var(--admin-border)',
                        borderRadius: '4px', color: 'var(--admin-text-secondary)',
                        fontWeight: '950', fontSize: '0.65rem', cursor: 'pointer',
                        textTransform: 'uppercase', whiteSpace: 'nowrap',
                        flexShrink: 0
                      }}
                    >
                      Block This Day
                    </button>
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

      <div style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: '8px', padding: '1.25rem', marginTop: '0.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', borderBottom: '1px solid var(--admin-border)', paddingBottom: '0.75rem' }}>
          <Tag size={16} color="var(--admin-brand)" />
          <h4 style={{ margin: 0, fontSize: '0.7rem', fontWeight: '950', textTransform: 'uppercase', letterSpacing: '1px' }}>Promo Management</h4>
        </div>

        {/* Compact Promotion Engine Panel */}
        <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--admin-border)', borderRadius: '8px', padding: '1.25rem', marginBottom: '1.5rem', fontFamily: 'inherit' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.75rem' }}>
            <div style={{ fontSize: '15px', fontWeight: '900', color: 'var(--admin-text-primary)' }}>
              {promoEditingId ? 'Edit Promo Rule' : 'Promotion Engine & Dynamic Binding'}
            </div>

            {/* Top-Level Workflow Mode Switcher */}
            <div style={{ display: 'inline-flex', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: '6px', padding: '2px' }}>
              <button
                type="button"
                onClick={() => {
                  setPromoDraft(prev => ({
                    ...prev,
                    mode: 'standard',
                    type: prev.type === 'fixed_package' ? 'percentage' : prev.type
                  }));
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.4rem 0.85rem',
                  borderRadius: '4px',
                  border: 'none',
                  background: promoDraft.mode !== 'package' ? 'var(--admin-brand)' : 'transparent',
                  color: promoDraft.mode !== 'package' ? '#fff' : 'var(--admin-text-secondary)',
                  fontWeight: '800',
                  fontSize: '12px',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease'
                }}
              >
                <Tag size={13} />
                <span>Standard Promo</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setPromoDraft(prev => ({
                    ...prev,
                    mode: 'package',
                    type: 'fixed_package'
                  }));
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.4rem 0.85rem',
                  borderRadius: '4px',
                  border: 'none',
                  background: promoDraft.mode === 'package' ? 'var(--admin-brand)' : 'transparent',
                  color: promoDraft.mode === 'package' ? '#fff' : 'var(--admin-text-secondary)',
                  fontWeight: '800',
                  fontSize: '12px',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease'
                }}
              >
                <Layers size={13} />
                <span>Package Promo</span>
              </button>
            </div>
          </div>

          {/* Compact 3-Column Responsive Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1.3fr', gap: '1rem', alignItems: 'start' }}>
            {/* Column 1: Basic Details */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
              <div style={{ fontSize: '14px', fontWeight: '700', color: 'var(--admin-text-primary)' }}>Basic Details</div>

              <div>
                <label style={{ fontSize: '12px', fontWeight: '500', color: 'var(--admin-text-secondary)', display: 'block', marginBottom: '0.25rem' }}>Promo Name</label>
                <input
                  type="text"
                  value={promoDraft.name}
                  onChange={(e) => setPromoDraft(prev => ({ ...prev, name: e.target.value }))}
                  placeholder={promoDraft.mode === 'package' ? 'VIP Detailing Bundle' : 'Weekend Special'}
                  style={{ height: '36px', fontSize: '13px', fontWeight: '400', border: '1px solid var(--admin-border)', borderRadius: '4px', padding: '0 0.65rem', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', boxSizing: 'border-box', width: '100%' }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                <div>
                  <label style={{ fontSize: '12px', fontWeight: '500', color: 'var(--admin-text-secondary)', display: 'block', marginBottom: '0.25rem' }}>
                    {promoDraft.mode === 'package' ? 'Package Type' : 'Discount Type'}
                  </label>
                  <select
                    value={promoDraft.type}
                    disabled={promoDraft.mode === 'package'}
                    onChange={(e) => setPromoDraft(prev => ({ ...prev, type: e.target.value }))}
                    style={{ height: '36px', fontSize: '13px', fontWeight: '400', border: '1px solid var(--admin-border)', borderRadius: '4px', padding: '0 0.65rem', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', boxSizing: 'border-box', width: '100%', opacity: promoDraft.mode === 'package' ? 0.7 : 1 }}
                  >
                    {promoDraft.mode === 'package' ? (
                      <option value="fixed_package">Fixed Bundle Price</option>
                    ) : (
                      <>
                        <option value="percentage">Percentage (%)</option>
                        <option value="fixed">Fixed Amount (₱)</option>
                      </>
                    )}
                  </select>
                </div>

                <div>
                  <label style={{ fontSize: '12px', fontWeight: '500', color: 'var(--admin-text-secondary)', display: 'block', marginBottom: '0.25rem' }}>
                    {promoDraft.mode === 'package' ? 'Package Price (₱)' : promoDraft.type === 'percentage' ? 'Discount (%)' : 'Discount (₱)'}
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={promoDraft.value}
                    onChange={(e) => setPromoDraft(prev => ({ ...prev, value: Number(e.target.value) || 0 }))}
                    style={{ height: '36px', fontSize: '13px', fontWeight: '400', border: '1px solid var(--admin-border)', borderRadius: '4px', padding: '0 0.65rem', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', boxSizing: 'border-box', width: '100%' }}
                  />
                </div>
              </div>
            </div>

            {/* Column 2: Duration & Schedule */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
              <div style={{ fontSize: '14px', fontWeight: '700', color: 'var(--admin-text-primary)' }}>Duration & Schedule</div>

              <div>
                <label style={{ fontSize: '12px', fontWeight: '500', color: 'var(--admin-text-secondary)', display: 'block', marginBottom: '0.25rem' }}>Valid From</label>
                <input
                  type="datetime-local"
                  value={promoDraft.validFrom}
                  onChange={(e) => setPromoDraft(prev => ({ ...prev, validFrom: e.target.value }))}
                  style={{ height: '36px', fontSize: '13px', fontWeight: '400', border: '1px solid var(--admin-border)', borderRadius: '4px', padding: '0 0.65rem', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', boxSizing: 'border-box', width: '100%' }}
                />
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label style={{ fontSize: '12px', fontWeight: '500', color: 'var(--admin-text-secondary)', display: 'block', marginBottom: '0.25rem' }}>Valid Until</label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: 'var(--admin-text-secondary)', fontSize: '11px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={promoDraft.neverExpires}
                      onChange={(e) => setPromoDraft(prev => ({ ...prev, neverExpires: e.target.checked }))}
                    />
                    Never Expires
                  </label>
                </div>
                <input
                  type="datetime-local"
                  value={promoDraft.validUntil}
                  disabled={promoDraft.neverExpires}
                  onChange={(e) => setPromoDraft(prev => ({ ...prev, validUntil: e.target.value }))}
                  style={{
                    height: '36px',
                    fontSize: '13px',
                    fontWeight: '400',
                    border: '1px solid var(--admin-border)',
                    borderRadius: '4px',
                    padding: '0 0.65rem',
                    background: promoDraft.neverExpires ? 'rgba(255,255,255,0.03)' : 'var(--admin-bg)',
                    color: promoDraft.neverExpires ? 'var(--admin-text-secondary)' : 'var(--admin-text-primary)',
                    boxSizing: 'border-box',
                    width: '100%',
                    opacity: promoDraft.neverExpires ? 0.6 : 1
                  }}
                />
              </div>
            </div>

            {/* Column 3: Dynamic Vehicle-Service Binding Scope */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: '14px', fontWeight: '700', color: 'var(--admin-text-primary)' }}>Vehicle & Service Binding</div>
                <span style={{ fontSize: '11px', color: 'var(--admin-text-secondary)' }}>
                  {Object.keys(promoDraft.vehicleServiceMatrix || {}).length} vehicle(s) bound
                </span>
              </div>

              <div style={{ maxHeight: '260px', overflowY: 'auto', paddingRight: '0.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {promoVehicleOptions.map(vehicle => {
                  const isVehicleSelected = Boolean(promoDraft.vehicleServiceMatrix?.[vehicle]);
                  const boundServices = promoDraft.vehicleServiceMatrix?.[vehicle] || [];
                  const availableServices = getAvailableServicesForVehicle(vehicle);
                  const isPopoverOpen = activeVehiclePopover === vehicle;

                  return (
                    <div
                      key={vehicle}
                      style={{
                        border: isVehicleSelected ? '1px solid var(--admin-brand)' : '1px solid var(--admin-border)',
                        background: isVehicleSelected ? 'rgba(230, 30, 42, 0.03)' : 'var(--admin-bg)',
                        borderRadius: '4px',
                        padding: '0.5rem 0.65rem',
                        transition: 'all 0.15s ease'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '12px', fontWeight: '700', color: 'var(--admin-text-primary)', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={isVehicleSelected}
                            onChange={() => toggleVehicleScope(vehicle)}
                          />
                          <span>{vehicle}</span>
                        </label>

                        {isVehicleSelected && (
                          <button
                            type="button"
                            onClick={() => setActiveVehiclePopover(isPopoverOpen ? null : vehicle)}
                            style={{
                              background: 'transparent',
                              border: '1px solid var(--admin-border)',
                              borderRadius: '3px',
                              color: isPopoverOpen ? 'var(--admin-brand)' : 'var(--admin-text-secondary)',
                              fontSize: '11px',
                              fontWeight: '800',
                              padding: '0.2rem 0.5rem',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.25rem'
                            }}
                          >
                            <span>{boundServices.length}/{availableServices.length} Services</span>
                            {isPopoverOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                          </button>
                        )}
                      </div>

                      {/* Inline Service Popover Panel / Nested Accordion */}
                      {isVehicleSelected && isPopoverOpen && (
                        <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px dashed var(--admin-border)', background: 'rgba(0,0,0,0.15)', borderRadius: '4px', padding: '0.5rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                            <span style={{ fontSize: '11px', fontWeight: '800', color: 'var(--admin-text-secondary)', textTransform: 'uppercase' }}>
                              Available Services for {vehicle}
                            </span>
                            <div style={{ display: 'flex', gap: '0.35rem' }}>
                              <button
                                type="button"
                                onClick={() => setAllServicesForVehicle(vehicle, 'all')}
                                style={{ background: 'transparent', border: 'none', color: 'var(--admin-brand)', fontSize: '11px', fontWeight: '800', cursor: 'pointer', padding: 0 }}
                              >
                                Select All
                              </button>
                              <span style={{ color: 'var(--admin-border)' }}>·</span>
                              <button
                                type="button"
                                onClick={() => setAllServicesForVehicle(vehicle, 'none')}
                                style={{ background: 'transparent', border: 'none', color: 'var(--admin-text-secondary)', fontSize: '11px', fontWeight: '800', cursor: 'pointer', padding: 0 }}
                              >
                                Clear All
                              </button>
                            </div>
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', maxHeight: '140px', overflowY: 'auto' }}>
                            {availableServices.map(svc => {
                              const isBound = boundServices.includes(svc.name);
                              return (
                                <label
                                  key={svc.id}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: '0.5rem',
                                    fontSize: '11px',
                                    color: isBound ? 'var(--admin-text-primary)' : 'var(--admin-text-secondary)',
                                    cursor: 'pointer',
                                    padding: '0.2rem 0.25rem',
                                    borderRadius: '3px',
                                    background: isBound ? 'rgba(255,255,255,0.04)' : 'transparent'
                                  }}
                                >
                                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                    <input
                                      type="checkbox"
                                      checked={isBound}
                                      onChange={() => toggleServiceForVehicle(vehicle, svc.name)}
                                    />
                                    <span>{svc.name}</span>
                                  </span>
                                  <span style={{ fontWeight: '700', color: 'var(--admin-brand)', fontSize: '11px' }}>
                                    ₱{svc.price.toLocaleString()}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {promoValidationError && (
            <div style={{ color: '#fca5a5', fontSize: '12px', fontWeight: '700', marginTop: '0.5rem' }}>
              {promoValidationError}
            </div>
          )}

          {/* Actions & Confirmation Lock Engine */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.85rem', paddingTop: '0.75rem', borderTop: '1px solid var(--admin-border)' }}>
            {promoEditingId && (
              <button
                type="button"
                onClick={resetPromoDraft}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--admin-border)',
                  color: 'var(--admin-text-secondary)',
                  borderRadius: '4px',
                  fontWeight: '800',
                  padding: '0.5rem 1rem',
                  fontSize: '12px',
                  cursor: 'pointer'
                }}
              >
                Cancel Edit
              </button>
            )}
            <button
              type="button"
              disabled={!isConfirmUnlocked || promoPublishing}
              onClick={handleCommitPromo}
              title={!isConfirmUnlocked ? 'Enter name, discount value, valid dates, and bind at least 1 vehicle-service mapping to unlock' : undefined}
              style={{
                background: isConfirmUnlocked ? '#059669' : '#374151',
                color: 'var(--admin-text-on-brand)',
                border: 'none',
                borderRadius: '4px',
                fontWeight: '900',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                fontSize: '12px',
                cursor: isConfirmUnlocked ? 'pointer' : 'not-allowed',
                padding: '0.55rem 1.25rem',
                minWidth: '180px',
                opacity: isConfirmUnlocked ? 1 : 0.5,
                pointerEvents: isConfirmUnlocked ? 'auto' : 'none',
                boxShadow: isConfirmUnlocked ? '0 0 0 1px rgba(5,150,105,0.4)' : 'none',
                transition: 'all 0.15s ease'
              }}
            >
              {promoPublishing ? 'Publishing...' : (promoEditingId ? 'Save Changes' : promoDraft.mode === 'package' ? 'Confirm Package' : 'Create Promo Rule')}
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', borderBottom: '1px solid var(--admin-border)', paddingBottom: '0.75rem' }}>
          <div style={{ fontSize: 'clamp(0.76rem, 0.45vw + 0.67rem, 0.86rem)', fontWeight: '950', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--admin-text-secondary)' }}>
            Campaign Promo Rules ({promoRules.length})
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {promoRules.map(rule => {
            const status = getPromoStatus(rule);
            const isOngoing = status === 'ONGOING PROMO';
            const isExpired = status === 'EXPIRED';

            return (
              <div
                key={rule.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '0.75rem',
                  background: 'var(--admin-bg)',
                  border: isOngoing
                    ? '1px solid rgba(16, 185, 129, 0.4)'
                    : '1px solid var(--admin-border)',
                  borderRadius: '4px',
                  padding: '0.9rem 1rem',
                  boxShadow: rule.id === promoEditingId ? '0 0 0 2px rgba(230,30,42,0.18)' : 'none',
                  animation: 'promoCardPulse 0.7s ease',
                  fontFamily: 'inherit'
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap' }}>
                    <div style={{ fontWeight: '950', fontSize: 'clamp(0.98rem, 0.6vw + 0.82rem, 1.18rem)' }}>
                      {rule.name}
                    </div>
                    {/* Dynamic Status Badge */}
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                        fontSize: 'clamp(0.62rem, 0.35vw + 0.55rem, 0.72rem)',
                        padding: '0.2rem 0.55rem',
                        borderRadius: '4px',
                        fontWeight: '950',
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        color: isOngoing ? '#10b981' : status === 'UPCOMING' ? '#3b82f6' : '#94a3b8',
                        background: isOngoing ? 'rgba(16, 185, 129, 0.12)' : status === 'UPCOMING' ? 'rgba(59, 130, 246, 0.12)' : 'rgba(148, 163, 184, 0.12)',
                        border: `1px solid ${isOngoing ? 'rgba(16, 185, 129, 0.35)' : status === 'UPCOMING' ? 'rgba(59, 130, 246, 0.35)' : 'rgba(148, 163, 184, 0.3)'}`
                      }}
                    >
                      <span
                        style={{
                          width: '6px',
                          height: '6px',
                          borderRadius: '50%',
                          background: isOngoing ? '#10b981' : status === 'UPCOMING' ? '#3b82f6' : '#94a3b8'
                        }}
                      />
                      {status}
                    </span>
                  </div>

                  <div style={{ color: 'var(--admin-text-secondary)', fontSize: 'clamp(0.76rem, 0.5vw + 0.64rem, 0.9rem)', marginTop: '0.25rem' }}>
                    <span style={{ fontWeight: '800', color: rule.mode === 'package' ? '#818cf8' : '#10b981', marginRight: '0.5rem' }}>
                      {rule.mode === 'package' ? `[PACKAGE: ₱${Number(rule.value || 0).toLocaleString()}]` : rule.type === 'percentage' ? `[${rule.value}% OFF]` : `[₱${Number(rule.value || 0).toLocaleString()} OFF]`}
                    </span>
                    · {rule.vehicleServiceMatrix
                      ? Object.entries(rule.vehicleServiceMatrix).map(([v, svcs]) => `${v} (${svcs.length} svcs)`).join(' · ')
                      : `${(rule.vehicleTypes || []).join(', ')} · ${(rule.serviceMatches || []).join(', ')}`}
                  </div>
                  <div style={{ fontSize: 'clamp(0.68rem, 0.35vw + 0.58rem, 0.78rem)', color: 'var(--admin-text-secondary)', marginTop: '0.35rem', fontWeight: '700' }}>
                    Valid: {formatPromoDate(rule.validFrom)} to {rule.neverExpires ? 'Never' : formatPromoDate(rule.validUntil)}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  {isOngoing ? (
                    <span
                      title="Active promotions cannot be edited while ongoing. Deactivate or wait for expiry."
                      style={{ display: 'inline-block', cursor: 'not-allowed' }}
                    >
                      <button
                        type="button"
                        disabled
                        tabIndex={-1}
                        title="Active promotions cannot be edited while ongoing. Deactivate or wait for expiry."
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          border: '1px solid rgba(255, 255, 255, 0.12)',
                          background: 'rgba(255, 255, 255, 0.05)',
                          color: 'var(--admin-text-secondary)',
                          padding: '0.5rem 0.8rem',
                          borderRadius: '4px',
                          fontWeight: '900',
                          fontSize: 'clamp(0.68rem, 0.35vw + 0.58rem, 0.8rem)',
                          cursor: 'not-allowed',
                          opacity: 0.45,
                          pointerEvents: 'none'
                        }}
                      >
                        <Lock size={12} />
                        Edit
                      </button>
                    </span>
                  ) : isExpired ? (
                    <span
                      title="Expired promotions cannot transition back into an editable state."
                      style={{ display: 'inline-block', cursor: 'not-allowed' }}
                    >
                      <button
                        type="button"
                        disabled
                        tabIndex={-1}
                        title="Expired promotions cannot transition back into an editable state."
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          border: '1px solid rgba(255, 255, 255, 0.12)',
                          background: 'rgba(255, 255, 255, 0.05)',
                          color: 'var(--admin-text-secondary)',
                          padding: '0.5rem 0.8rem',
                          borderRadius: '4px',
                          fontWeight: '900',
                          fontSize: 'clamp(0.68rem, 0.35vw + 0.58rem, 0.8rem)',
                          cursor: 'not-allowed',
                          opacity: 0.45,
                          pointerEvents: 'none'
                        }}
                      >
                        <Lock size={12} />
                        Edit
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleEditPromo(rule)}
                      style={{
                        border: '1px solid var(--admin-border)',
                        background: 'transparent',
                        color: 'var(--admin-text-primary)',
                        padding: '0.5rem 0.8rem',
                        borderRadius: '4px',
                        fontWeight: '900',
                        cursor: 'pointer',
                        fontSize: 'clamp(0.68rem, 0.35vw + 0.58rem, 0.8rem)'
                      }}
                    >
                      Edit
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => handleRemovePromo(rule.id)}
                    style={{
                      border: '1px solid #ef4444',
                      background: 'transparent',
                      color: 'var(--status-danger)',
                      padding: '0.5rem 0.8rem',
                      borderRadius: '4px',
                      fontWeight: '900',
                      cursor: 'pointer',
                      fontSize: 'clamp(0.68rem, 0.35vw + 0.58rem, 0.8rem)'
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default AdminSchedule;
