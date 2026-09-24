import React from 'react';
import { Clock, CheckCircle2, User, CreditCard, AlertCircle } from 'lucide-react';

const BookingAuditTrail = ({ logs = [] }) => {
  const formatLabel = (str) => {
    if (!str) return 'System Event';
    return str.split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  };

  const getEventConfig = (type) => {
    const t = (type || '').toUpperCase();
    if (t.includes('PAYMENT') || t.includes('REFUND') || t.includes('VERIFIED')) {
      return { color: 'var(--status-success)', icon: <CreditCard size={14} /> };
    }
    if (t.includes('STAFF') || t.includes('ASSIGN')) {
      return { color: '#3b82f6', icon: <User size={14} /> };
    }
    if (t.includes('COMPLETED') || t.includes('SUCCESS')) {
      return { color: 'var(--status-success)', icon: <CheckCircle2 size={14} /> };
    }
    return { color: 'var(--admin-text-secondary)', icon: <Clock size={14} /> };
  };

  const formatAuditDate = (dateStr) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }) + ' • ' + d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const renderDetails = (log) => {
    const rawDetails = log.metadata?.details || log.details;
    if (!rawDetails) return 'System event recorded.';

    let parsed = rawDetails;
    if (typeof rawDetails === 'string') {
      try { parsed = JSON.parse(rawDetails); } catch { parsed = rawDetails; }
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return String(parsed);
    }

    const entries = Object.entries(parsed).filter(([, value]) => value !== null && value !== undefined && value !== '');
    if (!entries.length) return 'System event recorded.';

    const formatValue = (value) => {
      if (!value || typeof value !== 'object') return String(value);
      return Object.entries(value)
        .filter(([, nested]) => nested !== null && nested !== undefined && nested !== '')
        .map(([key, nested]) => `${key.replace(/_/g, ' ')}: ${String(nested)}`)
        .join(' · ');
    };

    return (
      <dl style={{ margin: 0, display: 'grid', gap: '0.45rem' }}>
        {entries.map(([key, value]) => (
          <div key={key} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
            <dt style={{ color: 'var(--admin-text-secondary)', textTransform: 'uppercase', fontSize: '0.62rem', fontWeight: '900' }}>{key.replace(/_/g, ' ')}</dt>
            <dd style={{ margin: 0, color: 'var(--admin-text-primary)', fontSize: '0.75rem', fontWeight: '700', textAlign: 'right' }}>{formatValue(value)}</dd>
          </div>
        ))}
      </dl>
    );
  };

  return (
    <div style={{ position: 'relative', paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Timeline Connector Line */}
      <div style={{
        position: 'absolute',
        left: '0.45rem',
        top: '1rem',
        bottom: '1rem',
        width: '2px',
        background: 'var(--admin-border)',
        opacity: 0.5
      }}></div>

      {logs.map((log, i) => {
        const config = getEventConfig(log.event_type);
        const isRecent = i === 0;

        return (
          <div key={i} style={{ position: 'relative' }}>
            {/* Timeline Node */}
            <div style={{
              position: 'absolute',
              left: '-1.45rem',
              top: '0.25rem',
              width: '10px',
              height: '10px',
              borderRadius: '50%',
              background: config.color,
              border: '2px solid var(--admin-bg)',
              zIndex: 2
            }}></div>

            <div style={{
              padding: '1.25rem',
              background: isRecent ? 'rgba(255,255,255,0.02)' : 'var(--admin-card)',
              border: `1px solid ${isRecent ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
              borderRadius: 'var(--admin-radius-sm)',
              boxShadow: isRecent ? '0 4px 20px rgba(0,0,0,0.2)' : 'none'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ color: config.color }}>{config.icon}</span>
                  <span style={{ fontSize: '0.85rem', fontWeight: '950', color: 'var(--admin-text-on-brand)' }}>{formatLabel(log.event_type)}</span>
                  {isRecent && (
                    <span style={{
                      fontSize: '0.5rem',
                      fontWeight: '950',
                      background: 'var(--admin-brand)',
                      color: 'var(--admin-text-on-brand)', 
                      padding: '0.1rem 0.4rem', 
                      borderRadius: '2px',
                      letterSpacing: '0.5px'
                    }}>RECENT</span>
                  )}
                </div>
                <span style={{ fontSize: '0.65rem', color: 'var(--admin-text-secondary)', fontWeight: '800' }}>
                  {formatAuditDate(log.created_at)}
                </span>
              </div>
              <div style={{ margin: 0, fontSize: '0.8rem', color: 'var(--admin-text-secondary)', fontWeight: '600', lineHeight: 1.5 }}>
                {renderDetails(log)}
              </div>
            </div>
          </div>
        );
      })}
      
      {logs.length === 0 && (
        <div style={{ textAlign: 'center', padding: '2rem', background: 'var(--admin-bg)', borderRadius: 'var(--admin-radius)', border: '1px dashed var(--admin-border)', opacity: 0.5 }}>
          <AlertCircle size={24} style={{ marginBottom: '0.5rem' }} />
          <div style={{ fontSize: '0.8rem', fontWeight: '800' }}>No activity logs synchronized.</div>
        </div>
      )}
    </div>
  );
};

export default BookingAuditTrail;
