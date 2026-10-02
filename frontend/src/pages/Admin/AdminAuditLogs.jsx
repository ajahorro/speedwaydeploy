import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import PageHeader from '../../components/PageHeader';
import { Search, Filter, Database, ChevronDown, ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { logger } from '../../utils/logger';

/**
 * SYSTEM AUDIT TRAIL — monochromatic, container-free activity list.
 *
 * Design contract (per directive):
 *   1. NO color-coded badges. Every action tag uses one neutral style.
 *   2. NO table/card wrappers. A flat, line-divided list of rows.
 *   3. Two-line rows: (a) neutral [CATEGORY] tag + action title + timestamp;
 *      (b) a human-readable sentence with the primary entities bolded.
 *   4. Clicking a row expands an inline JSON drawer with the raw event record.
 */

// ── Category + action copy ──────────────────────────────
// Maps a raw action_type to a friendly category tag and an action title.
const ACTION_META = {
  INVITE_ACCOUNT: { category: 'ACCOUNTS', title: 'Account invited' },
  REVOKE_ACCESS: { category: 'ACCOUNTS', title: 'Access revoked' },
  ACCOUNT_DEACTIVATION: { category: 'ACCOUNTS', title: 'Account deactivated' },
  ACCOUNT_DATA_DELETION_REQUESTED: { category: 'COMPLIANCE', title: 'Data deletion requested' },
  SUPPORT_ISSUE_REPORTED: { category: 'SUPPORT', title: 'Issue reported' },
  BROADCAST_SENT: { category: 'NOTICES', title: 'Broadcast sent' },
  ASSIGN_STAFF: { category: 'SCHEDULING', title: 'Staff assigned' },
  CREATE_BOOKING: { category: 'BOOKINGS', title: 'Booking created' },
  AI_VERIFICATION_COMPLETE: { category: 'PAYMENTS', title: 'AI verification complete' },
  MANUAL_OVERRIDE_CONFIRM: { category: 'PAYMENTS', title: 'Payment confirmed (override)' },
  MANUAL_OVERRIDE_REJECT: { category: 'PAYMENTS', title: 'Payment rejected (override)' },
  STAFF_CLOCK_IN: { category: 'SHIFTS', title: 'Clocked in' },
  STAFF_CLOCK_OUT: { category: 'SHIFTS', title: 'Clocked out' },
  // ── Action types actually written by the app (audit_logs.action_type) ──
  // NOTE: audit_logs has NO `event_type` column — the earlier UI read the wrong
  // field, which is why every row fell back to a generic "System Event" title.
  SCHEDULE_SLOT_BLOCKED: { category: 'SCHEDULING', title: 'Schedule blocked' },
  ADMIN_PROCESSED_REFUND: { category: 'PAYMENTS', title: 'Refund processed' },
  SYSTEM_FLAG_NOSHOW: { category: 'BOOKINGS', title: 'No-show flagged' },
  QR_CONFIG_UPDATED: { category: 'BUSINESS', title: 'Payment QR updated' },
  BUSINESS_CONFIG_UPDATED: { category: 'BUSINESS', title: 'Business settings updated' },
  SERVICE_CATALOG_UPDATED: { category: 'BUSINESS', title: 'Service catalog updated' },
  SCHEDULE_SLOT_UNBLOCKED: { category: 'SCHEDULING', title: 'Schedule closure removed' },
  PROMO_CREATED: { category: 'BUSINESS', title: 'Promotion created' },
  PROMO_DEACTIVATED: { category: 'BUSINESS', title: 'Promotion deactivated' },
  BOOKING_CREATED: { category: 'BOOKINGS', title: 'Booking created' },
  BOOKING_UPDATED: { category: 'BOOKINGS', title: 'Booking updated' },
  BOOKING_MUTATED: { category: 'BOOKINGS', title: 'Booking updated' },
  BOOKING_MUTATED_FALLBACK: { category: 'BOOKINGS', title: 'Booking updated' },
  BOOKING_CONFIRMED: { category: 'BOOKINGS', title: 'Booking confirmed' },
  BOOKING_CANCELLED: { category: 'BOOKINGS', title: 'Booking cancelled' },
  STATUS_UPDATE: { category: 'BOOKINGS', title: 'Status updated' },
  TECHNICIAN_ASSIGNED: { category: 'SCHEDULING', title: 'Technician assigned' },
  PAYMENT_SUBMITTED: { category: 'PAYMENTS', title: 'Payment submitted' },
  PAYMENT_VERIFIED: { category: 'PAYMENTS', title: 'Payment verified' },
  PAYMENT_REJECTED: { category: 'PAYMENTS', title: 'Payment rejected' },
  REFUND_PROCESSED: { category: 'PAYMENTS', title: 'Refund processed' },
  SERVICE_STARTED: { category: 'SERVICE', title: 'Service started' },
  SERVICE_COMPLETED: { category: 'SERVICE', title: 'Service completed' },
  VEHICLE_COMPLETED: { category: 'SERVICE', title: 'Unit completed' },
  MESSAGE_RECEIVED: { category: 'MESSAGES', title: 'Message received' },
  STAFF_ASSIGNMENT_CHANGED: { category: 'SCHEDULING', title: 'Staff assignment changed' },
  PAYMENT_REFUND_QUEUED: { category: 'PAYMENTS', title: 'Payment refund queued' },
  UNDO_NO_SHOW: { category: 'BOOKINGS', title: 'No-show flag undone' },
  NOSHOW_FLAG_UNDONE: { category: 'BOOKINGS', title: 'No-show flag undone' },
};

const titleCase = (value) => String(value || '')
  .replace(/_/g, ' ')
  .toLowerCase()
  .replace(/\b\w/g, (c) => c.toUpperCase());

const getMeta = (actionType) => {
  const raw = String(actionType || 'EVENT').toUpperCase();
  return ACTION_META[raw] || { category: 'SYSTEM', title: titleCase(raw) };
};

// Short booking reference (#ABCD) used across several sentence templates.
const shortId = (id) => (id ? `#${String(id).slice(0, 4).toUpperCase()}` : 'N/A');

const getActorIdentity = (log) => {
  const role = String(log.profiles?.role || log.actor_role || 'SYSTEM').trim().toUpperCase();
  const recordedName = String(log.profiles?.full_name || log.actor_name || '').trim();
  const name = !recordedName || recordedName.toUpperCase() === role
    ? ({ ADMIN: 'Administrator', CUSTOMER: 'Customer', STAFF: 'Staff member', SYSTEM: 'System' }[role] || 'Unknown user')
    : recordedName;
  return { role, name };
};

/**
 * Build a clear, human-readable summary sentence for a log entry.
 * Primary entities are wrapped in <strong> so they stand out without color.
 * Returns an array of React nodes/strings (rendered inline).
 */
const buildSentence = (log) => {
  // audit_logs stores the action under `action_type`. Historically the UI read
  // `log.event_type` (a column that does not exist), so every switch fell through
  // to the generic default. Read the real column first, keep event_type as a
  // fallback for any future/legacy row shape.
  const raw = String(log.action_type || log.event_type || '').toUpperCase();
  const details = String(log.details || log.metadata?.description || '');
  const { role: performerRole, name: performerName } = getActorIdentity(log);
  const performer = <strong key="p">{performerRole} · {performerName}</strong>;
  const B = (t, k) => <strong key={k}>{t}</strong>;

  switch (raw) {
    case 'REVOKE_ACCESS': {
      // Details: "Account access revoked for {name} ({email}). Role downgraded..."
      const m = details.match(/revoked for (.+?)\s*\((.+?)\)/i);
      const target = m ? m[2] : null;
      return <>{performer} revoked access permissions for {B(target || 'a staff account', 't')}.</>;
    }
    case 'INVITE_ACCOUNT': {
      // Details: "Invited {name} ({email}) as {role}..."
      const m = details.match(/Invited (.+?)\s*\((.+?)\)\s*as\s*([A-Za-z]+)/i);
      if (m) return <>{performer} invited {B(`${m[1]} (${m[2]})`, 't')} as {B(m[3].toUpperCase(), 'r')}.</>;
      return <>{performer} sent an account invitation.</>;
    }
    case 'ACCOUNT_DEACTIVATION': {
      const m = details.match(/\((.+?)\)\s*initiated/i);
      return <>{B(m ? m[1] : 'A user', 't')} deactivated their account (15-day recovery window).</>;
    }
    case 'ACCOUNT_DATA_DELETION_REQUESTED':
      return <>{performer} requested permanent deletion of their account data.</>;
    case 'SUPPORT_ISSUE_REPORTED':
      return <>{performer} reported an issue: {B(details.split(':').slice(1).join(':').trim() || details, 't')}.</>;
    case 'BROADCAST_SENT': {
      const m = details.match(/transmitted to (\d+) users/i);
      return <>{performer} sent a system broadcast to {B(m ? m[1] : 'all', 'n')} {(m && m[1] === '1') ? 'user' : 'users'}.</>;
    }
    case 'ASSIGN_STAFF':
      return <>{performer} updated the staff assignment for booking {B(shortId(log.booking_id), 'b')}.</>;
    case 'CREATE_BOOKING':
    case 'BOOKING_CREATED':
      return <>{performer} created booking {B(shortId(log.booking_id), 'b')}.</>;
    case 'BOOKING_UPDATED':
    case 'BOOKING_MUTATED':
    case 'BOOKING_MUTATED_FALLBACK':
      return <>{performer} updated booking {B(shortId(log.booking_id), 'b')}.</>;
    case 'MANUAL_OVERRIDE_CONFIRM':
      return <>{performer} manually confirmed a flagged payment.</>;
    case 'MANUAL_OVERRIDE_REJECT':
      return <>{performer} manually rejected a payment{details.includes('Reason:') ? <> — {B(details.split('Reason:')[1].trim(), 'r')}</> : null}.</>;
    case 'AI_VERIFICATION_COMPLETE':
      return <>{performer} completed AI verification of a payment receipt.</>;
    case 'STAFF_CLOCK_IN':
      return <>{performer} clocked in (on duty).</>;
    case 'STAFF_CLOCK_OUT':
      return <>{performer} clocked out (off duty).</>;
    case 'SCHEDULE_SLOT_BLOCKED': {
      // Details: "Blocked schedule slots across N day(s): <reason>"
      const m = details.match(/across\s+(.+?)\s+day/i);
      const reasonMatch = details.match(/day\(s\):\s*(.+)$/i);
      const scope = m ? `${m[1]} ${Number(m[1]) === 1 ? 'day' : 'days'}` : 'the schedule';
      return <>{performer} blocked {B(scope, 's')}{reasonMatch ? <> for {B(reasonMatch[1].trim(), 'r')}</> : null}.</>;
    }
    case 'ADMIN_PROCESSED_REFUND': {
      // Details: "Administrator processed refund of ₱X. Ref: RFD-... Reason: ..."
      const amt = details.match(/(₱[\d.,]+)/);
      const ref = details.match(/Ref:\s*([A-Za-z0-9-]+)/i);
      const reason = details.match(/Reason:\s*(.+)$/i);
      return <>{performer} processed a refund{amt ? <> of {B(amt[1], 'a')}</> : null}{ref ? <> (ref {B(ref[1], 'ref')})</> : null}{reason ? <> — {reason[1].trim()}</> : null}.</>;
    }
    case 'SYSTEM_FLAG_NOSHOW':
      return <>Booking {B(shortId(log.booking_id), 'b')} was automatically flagged as a no-show (grace period elapsed).</>;
    case 'QR_CONFIG_UPDATED':
      return <>{performer} updated the payment QR recipients.</>;
    case 'PAYMENT_VERIFIED':
      return <>{performer} verified a payment for booking {B(shortId(log.booking_id), 'b')}.</>;
    case 'PAYMENT_REJECTED':
      return <>{performer} rejected a payment for booking {B(shortId(log.booking_id), 'b')}.</>;
    case 'BOOKING_CONFIRMED':
      return <>{performer} confirmed booking {B(shortId(log.booking_id), 'b')}.</>;
    case 'BOOKING_CANCELLED':
      return <>{performer} cancelled booking {B(shortId(log.booking_id), 'b')}{details ? <> — reason: {B(details, 'r')}</> : null}.</>;
    case 'UNDO_NO_SHOW':
    case 'NOSHOW_FLAG_UNDONE':
      return <>{performer} restored booking {B(shortId(log.booking_id), 'b')} after undoing its no-show flag.</>;
    case 'SERVICE_STARTED':
      return <>Work started on booking {B(shortId(log.booking_id), 'b')}.</>;
    case 'SERVICE_COMPLETED':
      return <>All services for booking {B(shortId(log.booking_id), 'b')} are complete.</>;
    case 'VEHICLE_COMPLETED':
      return <>A unit on booking {B(shortId(log.booking_id), 'b')} is ready for pickup.</>;
    default:
      // Never expose raw snake_case identifiers. If the stored details are a
      // complete, human sentence (which the writers always produce), show them
      // directly; otherwise fall back to the friendly action title + details.
      if (details && /\s/.test(details.trim()) && !details.trim().startsWith('{')) {
        return <>{performer}: {details}.</>;
      }
      return <>{performer} performed {B(getMeta(raw).title.toLowerCase(), 'a')}{details ? `: ${details}` : '.'}</>;
  }
};

const formatTimestamp = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today at ${time}`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString()} ${time}`;
};

// Shared neutral tag style — identical for every action type.
const TAG_STYLE = {
  display: 'inline-block',
  padding: '0.1rem 0.5rem',
  background: 'var(--admin-input-bg)',
  color: 'var(--admin-text-secondary)',
  border: '1px solid var(--admin-border)',
  borderRadius: '4px',
  fontSize: '0.62rem',
  fontWeight: 700,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

const AdminAuditLogs = () => {
  const isMobile = useMediaQuery('(max-width: 768px)');
  const navigate = useNavigate();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('ALL');
  const [expandedId, setExpandedId] = useState(null);
  const [isAuditListOpen, setIsAuditListOpen] = useState(false);
  const fetchSequence = useRef(0);

  const fetchLogs = useCallback(async () => {
    const sequence = ++fetchSequence.current;
    setLoading(true);
    try {
      logger.admin('Fetching live system audit trail...');
      let query = supabase
        .from('audit_logs')
        .select('*')
        .order('created_at', { ascending: false });
      if (filterType !== 'ALL') {
        const actionTypes = Object.entries(ACTION_META)
          .filter(([, meta]) => meta.category === filterType)
          .map(([actionType]) => actionType);
        query = query.in('action_type', actionTypes);
      }
      const { data, error } = await query.limit(100);

      if (error) throw error;
      if (sequence !== fetchSequence.current) return;

      const rows = data || [];

      // Resolve actor emails in one round-trip for every distinct actor id.
      const actorIds = Array.from(new Set(rows.map((l) => l.actor_id).filter(Boolean)));
      let actorById = {};
      if (actorIds.length) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, email, role')
          .in('id', actorIds);
        actorById = (profiles || []).reduce((acc, profile) => { acc[profile.id] = profile; return acc; }, {});
      }
      if (sequence !== fetchSequence.current) return;

      const processed = rows.map((l) => ({
        ...l,
        event_type: l.action_type,
        actor_email: actorById[l.actor_id]?.email || null,
        profiles: actorById[l.actor_id] || l.profiles || { full_name: l.actor_name || 'System', role: l.actor_role || 'SYSTEM' },
      }));

      const visibleLogs = processed.filter((log) => {
        if (String(log.action_type || '').toUpperCase() !== 'NOSHOW_FLAG_UNDONE') return true;
        const legacyTimestamp = new Date(log.created_at).getTime();
        return !processed.some((candidate) => {
          if (String(candidate.action_type || '').toUpperCase() !== 'UNDO_NO_SHOW'
            || candidate.booking_id !== log.booking_id) return false;
          const canonicalTimestamp = new Date(candidate.created_at).getTime();
          return Number.isFinite(legacyTimestamp)
            && Number.isFinite(canonicalTimestamp)
            && Math.abs(legacyTimestamp - canonicalTimestamp) <= 60_000;
        });
      });

      setLogs(visibleLogs);
      logger.admin('Audit trail synchronized.');
    } catch (err) {
      if (sequence !== fetchSequence.current) return;
      logger.error('Audit Fetch Error', err);
      toast.error('Failed to load audit trail');
    } finally {
      if (sequence === fetchSequence.current) setLoading(false);
    }
  }, [filterType]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const filteredLogs = logs.filter((log) => {
    const q = searchQuery.toLowerCase();
    const meta = getMeta(log.event_type);
    const matchesSearch =
      !q ||
      (log.action_type || log.event_type || '').toLowerCase().includes(q) ||
      meta.title.toLowerCase().includes(q) ||
      meta.category.toLowerCase().includes(q) ||
      log.profiles?.full_name?.toLowerCase().includes(q) ||
      (log.actor_email || '').toLowerCase().includes(q);

    const matchesFilter = filterType === 'ALL' || meta.category === filterType;
    return matchesSearch && matchesFilter;
  });

  // The technical record shown in the inline drawer, as ORDERED key/value rows.
  //
  // Audit findings addressed here:
  //   1. NO RAW JSON DUMP. The previous implementation rendered
  //      `JSON.stringify(technicalPayload(log), null, 2)` inside a <pre>, which
  //      put an unformatted blob in front of a non-technical auditor.
  //   2. NO DUPLICATED PERFORMER. `name`/`role` are already shown in the card
  //      header and in the human-readable sentence, so the drawer only carries
  //      the identifier fields that are NOT visible elsewhere.
  //   3. NO NULL CLUTTER. Fields with no value are omitted entirely rather than
  //      printed as `"old_value": null`, which padded every non-diff action
  //      (invites, broadcasts, logins) with meaningless rows.
  //
  // 🛡️ SCENARIO 7 FIX — NO NESTED JSON BLOB IN THE UI.
  // The bulk cron job inserts `metadata.old_values` / `new_values` as NESTED
  // JSON with null members (e.g. { total_amount: 150, staff_id: null }). The
  // previous code did `JSON.stringify(value)` for any object, so the drawer
  // showed a raw `{"total_amount":150,"staff_id":null}` string in a monospace
  // cell. We now FLATTEN one level into human sub-rows (`total_amount → 150`),
  // drop null/empty members, and only fall back to a compact string for arrays
  // or deeply-nested leftovers — never a dump of the whole payload.
  const flattenObjectRows = (prefix, value, sink) => {
    if (value === null || value === undefined || value === '') return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      sink.push({ label: `${prefix}`, value: value.map((entry) => (entry && typeof entry === 'object' ? compactEntry(entry) : String(entry))).join(', ') });
      return;
    }
    if (typeof value === 'object') {
      Object.entries(value)
        .filter(([, member]) => member !== null && member !== undefined && member !== '')
        .forEach(([key, member]) => flattenObjectRows(prefix ? `${prefix} · ${key.replace(/_/g, ' ')}` : key.replace(/_/g, ' '), member, sink));
      return;
    }
    sink.push({ label: prefix || 'value', value: String(value) });
  };

  const compactEntry = (entry) => Object.entries(entry)
    .filter(([, member]) => member !== null && member !== undefined && member !== '')
    .map(([key, member]) => `${key.replace(/_/g, ' ')}: ${typeof member === 'object' ? JSON.stringify(member) : member}`)
    .join(' · ');

  const technicalRows = (log) => {
    const rows = [];
    const push = (label, value) => {
      if (value === null || value === undefined || value === '') return;
      if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return;
      rows.push({ label, value });
    };

    // Old/new values only exist for diff-style actions, so they appear only when
    // the action actually captured them. Nested objects are FLATTENED into
    // readable sub-rows rather than dumped as a JSON string (Scenario 7).
    const oldValues = log.metadata?.old_values;
    const newValues = log.metadata?.new_values;
    if (oldValues !== undefined && oldValues !== null) {
      flattenObjectRows('Old · ', oldValues, rows);
    }
    if (newValues !== undefined && newValues !== null) {
      flattenObjectRows('New · ', newValues, rows);
    }

    // Any extra metadata keys the action recorded, minus the two already shown
    // above, surfaced as their own readable rows instead of a nested blob.
    const meta = log.metadata;
    if (meta && typeof meta === 'object') {
      Object.entries(meta)
        .filter(([key, value]) => !['old_values', 'new_values'].includes(key)
          && value !== null && value !== undefined && value !== '')
        .forEach(([key, value]) => {
          // Scenario 7: a nested object is flattened into `key · child` rows so
          // the UI never shows a raw JSON blob (and null children are dropped).
          flattenObjectRows(key.replace(/_/g, ' '), value, rows);
        });
    }

    return rows;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingBottom: '4rem' }}>
      <PageHeader
        showBack
        onBack={() => navigate(-1)}
        badge="SYSTEM SECURITY"
        title="System Audit Trail"
        subtitle="Track all administrative actions and system changes"
        onRefresh={fetchLogs}
      />

      {/* Filters — flat, no card wrapper. */}
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', borderBottom: '1px solid var(--admin-border)', paddingBottom: '1rem' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: isMobile ? '100%' : '300px' }}>
          <Search size={18} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--admin-text-secondary)' }} />
          <input
            type="text"
            placeholder="Search action or performer..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: '100%', padding: '0.75rem 1rem 0.75rem 2.75rem',
              background: 'var(--admin-input-bg)', border: '1px solid var(--admin-input-border)',
              borderRadius: 0, color: 'var(--admin-text-primary)',
              fontSize: '0.85rem', outline: 'none', fontWeight: 600,
            }}
          />
        </div>
        <div style={{ position: 'relative', width: isMobile ? '100%' : '180px' }}>
          <Filter size={18} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--admin-text-secondary)' }} />
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            style={{
              width: '100%', padding: '0.75rem 1rem 0.75rem 2.75rem',
              background: 'var(--admin-input-bg)', border: '1px solid var(--admin-input-border)',
              borderRadius: 0, color: 'var(--admin-text-primary)',
              fontSize: '0.85rem', outline: 'none', appearance: 'none', fontWeight: 600,
            }}
          >
            <option value="ALL">All activity</option>
            <option value="PAYMENTS">Payments &amp; refunds</option>
            <option value="BOOKINGS">Bookings</option>
            <option value="SCHEDULING">Staff &amp; scheduling</option>
            <option value="SERVICE">Service activity</option>
            <option value="ACCOUNTS">Accounts</option>
          </select>
        </div>
      </div>

      {isMobile && (
        <button
          type="button"
          aria-expanded={isAuditListOpen}
          aria-controls="audit-activity-list"
          onClick={() => setIsAuditListOpen((open) => !open)}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            width: '100%', padding: '0.85rem 1rem',
            background: 'var(--admin-card)', color: 'var(--admin-text-primary)',
            border: '1px solid var(--admin-border)', borderRadius: 0,
            fontSize: '0.8rem', fontWeight: 800, textAlign: 'left',
          }}
        >
          Audit activity
          <ChevronDown size={16} style={{ transform: isAuditListOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }} />
        </button>
      )}

      <div
        id="audit-activity-list"
        hidden={isMobile && !isAuditListOpen}
        style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 0, padding: '0.5rem 1.5rem' }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
        {loading ? (
          [1, 2, 3, 4, 5].map((i) => (
            <div key={i} style={{ height: '58px', borderBottom: '1px solid var(--admin-border)' }} className="animate-pulse" />
          ))
        ) : filteredLogs.length > 0 ? (
          filteredLogs.map((log) => {
            const meta = getMeta(log.event_type);
            const isOpen = expandedId === log.id;
            const { role: actorRole, name: actorName } = getActorIdentity(log);
            return (
              <div key={log.id} style={{ borderBottom: '1px solid var(--admin-border)' }}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setExpandedId(isOpen ? null : log.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedId(isOpen ? null : log.id); } }}
                  style={{ padding: '0.9rem 0.5rem', cursor: 'pointer', transition: 'background 0.15s ease', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--admin-input-bg)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  {/* Line 1: tag + title (left) — timestamp (right). */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', minWidth: 0 }}>
                      <span style={TAG_STYLE}>{meta.category}</span>
                      <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--admin-text-primary)' }}>{meta.title}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                      <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--admin-text-secondary)', whiteSpace: 'nowrap' }}>
                        {formatTimestamp(log.created_at)}
                      </span>
                      <ChevronDown size={16} style={{ color: 'var(--admin-text-secondary)', transition: 'transform 0.2s ease', transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)' }} />
                    </div>
                  </div>

                  {/* Line 2: human-readable sentence. */}
                  <div style={{ fontSize: '0.8rem', color: 'var(--admin-text-secondary)', fontWeight: 500, lineHeight: 1.5, paddingRight: '2rem' }}>
                    {buildSentence(log)}
                  </div>
                </div>

                {/* Inline expandable technical detail — key/value badges, not a
                    raw JSON blob, so an auditor can scan it in one pass. */}
                {isOpen && (
                  <div style={{ padding: '0 0.5rem 1rem' }}>
                    <dl style={{
                      margin: '0 0 0.5rem',
                      background: 'var(--admin-input-bg)',
                      border: '1px solid var(--admin-border)',
                      borderRadius: 0,
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                      gap: '1px',
                    }}>
                      <div style={{ padding: '.6rem .75rem', display: 'flex', flexDirection: 'column', gap: '.15rem', minWidth: 0 }}>
                        <dt style={{ fontSize: '.58rem', fontWeight: 900, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Action</dt>
                        <dd style={{ margin: 0, fontSize: '.72rem', fontWeight: 700, color: 'var(--admin-text-primary)', overflowWrap: 'anywhere' }}>{log.action_type || log.event_type || 'System event'}</dd>
                      </div>
                      <div style={{ padding: '.6rem .75rem', display: 'flex', flexDirection: 'column', gap: '.15rem', minWidth: 0 }}>
                        <dt style={{ fontSize: '.58rem', fontWeight: 900, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Activity By</dt>
                        <dd style={{ margin: 0, fontSize: '.72rem', fontWeight: 700, color: 'var(--admin-text-primary)', overflowWrap: 'anywhere' }}>
                          {actorRole} · {actorName}
                        </dd>
                      </div>
                      <div style={{ padding: '.6rem .75rem', display: 'flex', flexDirection: 'column', gap: '.15rem', minWidth: 0 }}>
                        <dt style={{ fontSize: '.58rem', fontWeight: 900, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Timestamp</dt>
                        <dd style={{ margin: 0, fontSize: '.72rem', fontWeight: 700, color: 'var(--admin-text-primary)', overflowWrap: 'anywhere' }}>
                          {log.created_at ? new Date(log.created_at).toLocaleString() : 'Unavailable'}
                        </dd>
                      </div>
                      <div style={{ padding: '.6rem .75rem', display: 'flex', flexDirection: 'column', gap: '.15rem', minWidth: 0 }}>
                        <dt style={{ fontSize: '.58rem', fontWeight: 900, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '.05em' }}>View Booking</dt>
                        <dd style={{ margin: 0 }}>
                          {log.booking_id ? (
                            <button
                              type="button"
                              onClick={() => navigate(`/admin/bookings/${log.booking_id}`)}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: 0, background: 'transparent', border: 'none', color: 'var(--admin-text-primary)', fontSize: '.72rem', fontWeight: 800, textTransform: 'uppercase', cursor: 'pointer' }}
                            >
                              <ExternalLink size={13} /> View booking {shortId(log.booking_id)}
                            </button>
                          ) : (
                            <span style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--admin-text-secondary)' }}>Not linked to a booking</span>
                          )}
                        </dd>
                      </div>
                    </dl>
                    <dl style={{
                      margin: 0, background: 'var(--admin-input-bg)',
                      border: '1px solid var(--admin-border)', borderRadius: 0,
                      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                      gap: '1px',
                    }}>
                      {technicalRows(log).map(({ label, value }) => (
                        <div key={label} style={{ padding: '.6rem .75rem', display: 'flex', flexDirection: 'column', gap: '.15rem', minWidth: 0 }}>
                          <dt style={{ fontSize: '.58rem', fontWeight: 900, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</dt>
                          <dd style={{ margin: 0, fontSize: '.72rem', fontWeight: 700, color: 'var(--admin-text-primary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-word' }}>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <div style={{ textAlign: 'center', padding: '4rem 1rem', color: 'var(--admin-text-secondary)' }}>
            <Database size={40} style={{ marginBottom: '1rem', opacity: 0.3 }} />
            <p style={{ fontWeight: 700, fontSize: '0.9rem', margin: 0 }}>No logs found</p>
          </div>
        )}
        </div>
      </div>
    </div>
  );
};

export default AdminAuditLogs;