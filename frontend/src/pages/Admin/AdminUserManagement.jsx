import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import PageHeader from '../../components/PageHeader';
import { 
  Users, Search, Mail, Phone, User, ChevronRight, 
  History, Calendar, CheckCircle2, Shield, UserCog, ExternalLink, Trash2
} from 'lucide-react';
import toast from '@/lib/toast';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { logger } from '../../utils/logger';
import { BACKEND_URL, authHeaders } from '../../config/api';
import { matchesSearchText } from '../../utils/searchMatch';
import { normalizePhPhone } from '../../utils/contactValidation';
import { useLanguage } from '../../context/LanguageContext';
import { fetchWithCache, invalidateCache } from '../../lib/cache';
import { useAuth } from '../../context/AuthContext';

const AdminUserManagement = () => {
  const navigate = useNavigate();
  const isMobile = useMediaQuery('(max-width: 768px)');
  const { language } = useLanguage();
  const { user: currentUser } = useAuth();
  const [defaultAdminId, setDefaultAdminId] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [view, setView] = useState('list');
  const [selectedUser, setSelectedUser] = useState(null);
  const [userBookings, setUserBookings] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async (forceRefresh = false) => {
    if (!users.length) setLoading(true);
    try {
      logger.admin('Fetching system directory...');
      const result = await fetchWithCache('admin_profiles', async () => {
        const response = await fetch(`${BACKEND_URL}/api/admin/profiles`, { headers: await authHeaders() });
        const json = await response.json();
        if (!json.success) throw new Error(json.error);
        return json;
      }, { ttl: 60000, swr: true, forceRefresh });

      setUsers(result.data || []);
      if (result.defaultAdminId) setDefaultAdminId(result.defaultAdminId);
      logger.admin('System directory synchronized.');
    } catch (err) {
      logger.error('User Fetch Error', err);
      toast.error('Failed to load client directory.');
    } finally {
      setLoading(false);
    }
  };

  const handleSeeHistory = async (user) => {
    setSelectedUser(user);
    setView('history');
    setLoadingHistory(true);
    try {
      logger.admin(`Fetching history for user: ${user.id}`);
      const data = await fetchWithCache(`user_history_${user.id}`, async () => {
        const { data: bData, error } = await supabase
          .from('bookings')
          .select(`
            *,
            vehicles:booking_vehicles(*, services:booking_vehicle_services(*))
          `)
          .eq('customer_id', user.id)
          .order('start_datetime', { ascending: false });

        if (error) throw error;
        return bData;
      }, { ttl: 30000, swr: true });
      
      const processed = (data || []).map(b => ({
        ...b,
        services: b.vehicles?.flatMap(v => v.services || []) || []
      }));

      setUserBookings(processed);
      logger.admin('User history synchronized.');
    } catch (err) {
      logger.error('History Fetch Error', err);
      toast.error('Failed to load user history.');
    } finally {
      setLoadingHistory(false);
    }
  };

  const filteredUsers = users.filter(u => {
    // Client directory only displays CUSTOMER accounts
    if (u.role !== 'CUSTOMER') return false;
    const phone = u.phone_number || u.phone || u.contact_number || '';
    const matchesSearch = matchesSearchText(searchQuery, u.full_name, u.email, phone, normalizePhPhone(phone));
    return matchesSearch;
  });

  const handleDeleteUser = async (userToDelete) => {
    if (!userToDelete) return;
    const isSelf = userToDelete.id === currentUser?.id;
    const isDefault = userToDelete.id === defaultAdminId;
    if (isSelf) return toast.error('You cannot delete your own account.');
    if (isDefault) return toast.error('The Default Admin account cannot be deleted.');

    const name = userToDelete.full_name || userToDelete.email;
    const confirmed = window.confirm(
      `Are you sure you want to permanently DELETE the account for ${name}? This will remove their credentials and account access.`
    );
    if (!confirmed) return;

    const toastId = toast.loading(`Deleting account ${name}...`);
    try {
      const response = await fetch(`${BACKEND_URL}/api/admin/delete-account`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ memberId: userToDelete.id, email: userToDelete.email })
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Failed to delete account');
      toast.success(`Account for ${name} permanently deleted.`, { id: toastId });
      if (view === 'history') setView('list');
      invalidateCache('admin_profiles');
      fetchUsers(true);
    } catch (err) {
      toast.error(err.message || 'Failed to delete account', { id: toastId });
    }
  };

  const getRoleBadge = (role) => {
    switch (role) {
      case 'ADMIN': return { color: 'var(--status-danger)', label: 'ADMINISTRATOR', icon: <Shield size={10} /> };
      case 'STAFF': return { color: '#3b82f6', label: 'STAFF', icon: <UserCog size={10} /> };
      default: return { color: 'var(--admin-text-secondary)', label: 'CUSTOMER', icon: <User size={10} /> };
    }
  };

  const getStatusColor = (status) => {
    const s = String(status || '').toUpperCase();
    switch (s) {
      case 'COMPLETED':
      case 'RELEASED':
        return { bg: 'rgba(16, 185, 129, 0.12)', text: 'var(--status-success, #10b981)', border: 'rgba(16, 185, 129, 0.3)' };
      case 'CANCELLED':
      case 'FLAGGED_NOSHOW':
      case 'NO_SHOW':
        return { bg: 'rgba(239, 68, 68, 0.12)', text: 'var(--status-danger, #ef4444)', border: 'rgba(239, 68, 68, 0.3)' };
      case 'CONFIRMED':
      case 'SCHEDULED':
      case 'PAID':
        return { bg: 'rgba(59, 130, 246, 0.12)', text: 'var(--status-info, #3b82f6)', border: 'rgba(59, 130, 246, 0.3)' };
      default:
        return { bg: 'var(--admin-bg)', text: 'var(--admin-text-secondary)', border: 'var(--admin-border)' };
    }
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(language === 'tl' ? 'fil-PH' : 'en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', animation: 'fadeIn 0.5s ease' }}>
      <PageHeader 
        badge="ACCESS CONTROL"
        title={view === 'list' ? "Client Directory" : "Client History"}
        subtitle={view === 'list' ? "Manage client accounts and monitor customer history" : `Service timeline for ${selectedUser?.full_name}`}
        onRefresh={view === 'list' ? fetchUsers : () => handleSeeHistory(selectedUser)}
      />

      {view === 'list' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%' }}>
          {/* Controls Bar */}
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ position: 'relative', flex: 1, minWidth: isMobile ? '100%' : '300px' }}>
              <Search size={18} style={{ position: 'absolute', left: '1.25rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--admin-text-secondary)' }} />
              <input 
                type="text" 
                placeholder="Search by name, email, or phone..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ 
                  width: '100%', padding: '0.85rem 1.25rem 0.85rem 3.5rem', 
                  background: 'var(--admin-card)', border: '1px solid var(--admin-border)', 
                  borderRadius: 'var(--admin-radius-sm)', color: 'var(--admin-text-primary)', fontWeight: '700', outline: 'none'
                }}
              />
            </div>
            
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.65rem 1.25rem',
              background: 'var(--admin-card)',
              border: '1px solid var(--admin-border)',
              borderRadius: 'var(--admin-radius-sm)',
              color: 'var(--admin-text-secondary)',
              fontSize: '0.75rem',
              fontWeight: '900',
              textTransform: 'uppercase',
              letterSpacing: '0.5px'
            }}>
              <Users size={14} color="var(--admin-brand)" />
              <span>{filteredUsers.length} {filteredUsers.length === 1 ? 'Client' : 'Clients'}</span>
            </div>
          </div>

          {/* User Grid - STACKED RECTANGLE CONTAINERS */}
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(340px, 1fr))', gap: '1rem' }}>
            {loading ? (
              [1, 2, 3, 4, 5, 6].map(i => (
                <div key={i} style={{ height: '140px', background: 'var(--admin-card)', borderRadius: 'var(--admin-radius)', border: '1px solid var(--admin-border)' }} className="animate-pulse"></div>
              ))
            ) : filteredUsers.length > 0 ? (
              filteredUsers.map((user) => {
                const roleBadge = getRoleBadge(user.role);
                return (
                  <div 
                    key={user.id}
                    className="user-rectangle-card"
                    style={{ 
                      background: 'var(--admin-card)',
                      border: '1px solid var(--admin-border)', 
                      borderRadius: 'var(--admin-radius)',
                      padding: '1.25rem',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      gap: '0.85rem',
                      transition: 'all 0.2s ease',
                      boxShadow: 'var(--admin-card-shadow)'
                    }}
                  >
                    {/* Top Row: Avatar, Name & Role, and View History Button */}
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0, flex: 1 }}>
                        <div style={{ 
                          width: '42px', height: '42px', borderRadius: 'var(--admin-radius-sm)', 
                          background: 'var(--admin-bg)', display: 'flex', alignItems: 'center', 
                          justifyContent: 'center', color: roleBadge.color, 
                          fontSize: '1.15rem', fontWeight: '950', border: `1px solid ${roleBadge.color}44`,
                          flexShrink: 0
                        }}>
                          {user.full_name?.charAt(0).toUpperCase() || <User size={20} />}
                        </div>

                        <div style={{ minWidth: 0, flex: 1 }}>
                          <h3 style={{ 
                            margin: 0, 
                            fontSize: '0.95rem', 
                            fontWeight: '950', 
                            color: 'var(--admin-text-primary)', 
                            textTransform: 'uppercase',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }}>
                            {user.full_name}
                          </h3>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.55rem', fontWeight: '950', color: roleBadge.color, background: `${roleBadge.color}15`, padding: '0.1rem 0.45rem', borderRadius: '3px', border: `1px solid ${roleBadge.color}33`, textTransform: 'uppercase', marginTop: '0.2rem' }}>
                            {roleBadge.icon} {roleBadge.label}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0 }}>
                        {/* View History Button */}
                        <button 
                          onClick={() => handleSeeHistory(user)}
                        title="View Booking History"
                        style={{ 
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          padding: '0.45rem 0.8rem',
                          borderRadius: 'var(--admin-radius-sm)',
                          background: 'var(--admin-bg)', 
                          border: '1px solid var(--admin-border)',
                          color: 'var(--admin-text-primary)',
                          fontSize: '0.68rem',
                          fontWeight: '950',
                          textTransform: 'uppercase',
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                          flexShrink: 0,
                          transition: 'all 0.2s ease'
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.borderColor = 'var(--admin-brand)';
                          e.currentTarget.style.color = 'var(--admin-brand)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.borderColor = 'var(--admin-border)';
                          e.currentTarget.style.color = 'var(--admin-text-primary)';
                        }}
                      >
                        <History size={13} color="var(--admin-brand)" /> View History
                        </button>

                        {user.id !== defaultAdminId && user.id !== currentUser?.id && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteUser(user); }}
                            title="Delete Account Permanently"
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              padding: '0.45rem 0.55rem',
                              borderRadius: 'var(--admin-radius-sm)',
                              background: 'rgba(239, 68, 68, 0.08)',
                              border: '1px solid rgba(239, 68, 68, 0.25)',
                              color: 'var(--status-danger)',
                              cursor: 'pointer',
                              transition: 'all 0.2s ease'
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = 'var(--status-danger)';
                              e.currentTarget.style.color = '#ffffff';
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)';
                              e.currentTarget.style.color = 'var(--status-danger)';
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Bottom Details: Email, Phone, Joined Date */}
                    <div style={{ 
                      display: 'flex', 
                      flexDirection: 'column', 
                      gap: '0.35rem', 
                      borderTop: '1px solid var(--admin-border)', 
                      paddingTop: '0.75rem',
                      fontSize: '0.72rem',
                      color: 'var(--admin-text-secondary)',
                      fontWeight: '700'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                        <Mail size={12} color="var(--admin-brand)" style={{ flexShrink: 0 }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email || '—'}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Phone size={12} color="var(--admin-brand)" style={{ flexShrink: 0 }} />
                        <span>{user.phone_number || user.phone || user.contact_number || 'No phone provided'}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', opacity: 0.9 }}>
                        <Calendar size={12} color="var(--admin-brand)" style={{ flexShrink: 0 }} />
                        <span>Joined at: <strong style={{ color: 'var(--admin-text-primary)' }}>{formatDate(user.created_at)}</strong></span>
                      </div>
                    </div>
                  </div>
                );
              })
            ) : (
              <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: '5rem', background: 'var(--admin-card)', borderRadius: 'var(--admin-radius)', border: '1px dashed var(--admin-border)' }}>
                <Users size={64} style={{ color: 'var(--admin-text-secondary)', marginBottom: '1.5rem', opacity: 0.1 }} />
                <h3 style={{ fontSize: '1.25rem', fontWeight: '950', color: 'var(--admin-text-primary)', textTransform: 'uppercase' }}>No matching clients found</h3>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div style={{ width: '100%' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <button 
              onClick={() => setView('list')}
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'transparent', border: 'none', color: 'var(--admin-brand)', fontWeight: '950', cursor: 'pointer', fontSize: '0.8rem', textTransform: 'uppercase', width: 'fit-content' }}
            >
              <ChevronRight size={18} style={{ transform: 'rotate(180deg)' }} /> BACK TO CLIENT DIRECTORY
            </button>

            {/* Customer Summary Banner */}
            <div style={{ 
              background: 'var(--admin-card)', borderRadius: 'var(--admin-radius)', 
              padding: isMobile ? '1.25rem' : '1.75rem', border: '1px solid var(--admin-border)',
              display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: '1.25rem', alignItems: isMobile ? 'flex-start' : 'center',
              boxShadow: 'var(--admin-card-shadow)'
            }}>
              <div style={{ 
                width: isMobile ? '56px' : '72px', height: isMobile ? '56px' : '72px', borderRadius: 'var(--admin-radius-sm)', 
                background: 'var(--admin-bg)', display: 'flex', alignItems: 'center', 
                justifyContent: 'center', color: 'var(--admin-brand)', fontSize: isMobile ? '1.75rem' : '2.25rem',
                fontWeight: '950', border: '1px solid var(--admin-border)', flexShrink: 0
              }}>
                {selectedUser?.full_name?.charAt(0)}
              </div>
              
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                  <h2 style={{ fontSize: isMobile ? '1.35rem' : '1.75rem', fontWeight: '950', color: 'var(--admin-text-primary)', margin: 0, textTransform: 'uppercase', wordBreak: 'break-word' }}>
                    {selectedUser?.full_name}
                  </h2>
                  {selectedUser?.id !== defaultAdminId && selectedUser?.id !== currentUser?.id && (
                    <button
                      onClick={() => handleDeleteUser(selectedUser)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                        padding: '0.45rem 0.85rem',
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        borderRadius: 'var(--admin-radius-sm)',
                        color: 'var(--status-danger)',
                        fontSize: '0.72rem',
                        fontWeight: '950',
                        textTransform: 'uppercase',
                        cursor: 'pointer'
                      }}
                    >
                      <Trash2 size={13} /> Delete Account
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.25rem', marginTop: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--admin-text-secondary)', fontSize: '0.8rem', fontWeight: '800' }}>
                    <Mail size={15} color="var(--admin-brand)" /> {selectedUser?.email}
                  </div>
                  {(selectedUser?.phone_number || selectedUser?.phone || selectedUser?.contact_number || (userBookings.find(b => b.contact_number || b.customer_phone)?.contact_number || userBookings.find(b => b.contact_number || b.customer_phone)?.customer_phone)) && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--admin-text-secondary)', fontSize: '0.8rem', fontWeight: '800' }}>
                      <Phone size={15} color="var(--admin-brand)" /> {selectedUser?.phone_number || selectedUser?.phone || selectedUser?.contact_number || (userBookings.find(b => b.contact_number || b.customer_phone)?.contact_number || userBookings.find(b => b.contact_number || b.customer_phone)?.customer_phone)}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--admin-text-secondary)', fontSize: '0.8rem', fontWeight: '800' }}>
                    <CheckCircle2 size={15} color="var(--admin-brand)" /> {userBookings.length} SYSTEM RECORDS
                  </div>
                </div>
              </div>
            </div>

            {/* History Bookings List */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {loadingHistory ? (
                [1, 2, 3].map(i => (
                  <div key={i} style={{ height: '110px', background: 'var(--admin-card)', borderRadius: 'var(--admin-radius)', border: '1px solid var(--admin-border)' }} className="animate-pulse"></div>
                ))
              ) : userBookings.length > 0 ? (
                userBookings.map((booking) => {
                  const statusInfo = getStatusColor(booking.status);
                  const bookingDate = new Date(booking.start_datetime);
                  const isValidDate = !Number.isNaN(bookingDate.getTime());
                  const day = isValidDate ? bookingDate.getDate() : '—';
                  const monthYear = isValidDate 
                    ? bookingDate.toLocaleDateString(language === 'tl' ? 'fil-PH' : 'en-US', { month: 'short', year: 'numeric' }) 
                    : '';

                  return (
                    <div 
                      key={booking.id}
                      onClick={() => navigate(`/admin/bookings/${booking.id}`)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          navigate(`/admin/bookings/${booking.id}`);
                        }
                      }}
                      title="Click to view full booking details"
                      className="booking-history-card"
                      style={{
                        background: 'var(--admin-card)', borderRadius: 'var(--admin-radius)',
                        padding: isMobile ? '1rem 1.25rem' : '1.5rem', border: '1px solid var(--admin-border)',
                        display: 'flex', flexDirection: isMobile ? 'column' : 'row',
                        gap: isMobile ? '1rem' : '1.75rem', alignItems: isMobile ? 'flex-start' : 'center',
                        cursor: 'pointer', transition: 'all 0.2s ease', position: 'relative',
                        boxShadow: 'var(--admin-card-shadow)'
                      }}
                    >
                      {/* Date Block */}
                      <div style={{ 
                        width: isMobile ? '100%' : '110px', padding: isMobile ? '0.6rem 1rem' : '0.85rem', background: 'var(--admin-bg)', 
                        borderRadius: 'var(--admin-radius-sm)', textAlign: 'center', border: '1px solid var(--admin-border)',
                        display: 'flex', flexDirection: isMobile ? 'row' : 'column', alignItems: 'center', justifyContent: 'center', gap: isMobile ? '0.75rem' : '0.15rem'
                      }}>
                        <div style={{ fontSize: isMobile ? '1.3rem' : '1.75rem', fontWeight: '950', color: 'var(--admin-text-primary)' }}>
                          {day}
                        </div>
                        <div style={{ fontSize: '0.7rem', fontWeight: '900', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                          {monthYear}
                        </div>
                      </div>

                      {/* Info & Services Block */}
                      <div style={{ flex: 1, minWidth: 0, width: isMobile ? '100%' : 'auto' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
                          <span style={{ 
                            padding: '0.2rem 0.6rem', borderRadius: '3px', 
                            background: statusInfo.bg, color: statusInfo.text, fontSize: '0.65rem', 
                            fontWeight: '950', textTransform: 'uppercase', border: `1px solid ${statusInfo.border}`
                          }}>
                            {String(booking.status || '').replace('_', ' ')}
                          </span>
                          <span style={{ fontSize: '0.75rem', color: 'var(--admin-text-secondary)', fontWeight: '800' }}>
                            #{String(booking.id || '').slice(0, 8).toUpperCase()}
                          </span>
                        </div>
                        
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                          {(booking.services || []).length > 0 ? (
                            booking.services.map((s, idx) => (
                              <span key={idx} style={{ fontSize: '0.75rem', fontWeight: '900', color: 'var(--admin-text-primary)', background: 'var(--admin-bg)', padding: '0.3rem 0.65rem', borderRadius: 'var(--admin-radius-sm)', border: '1px solid var(--admin-border)', textTransform: 'uppercase' }}>
                                {s.service_name}
                              </span>
                            ))
                          ) : (
                            <span style={{ fontSize: '0.75rem', color: 'var(--admin-text-secondary)', fontStyle: 'italic' }}>
                              Standard Service
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Revenue & Arrow Block */}
                      <div style={{ 
                        display: 'flex', alignItems: 'center', justifyContent: isMobile ? 'space-between' : 'flex-end',
                        gap: '1rem', width: isMobile ? '100%' : 'auto', minWidth: isMobile ? 'auto' : '160px',
                        borderTop: isMobile ? '1px solid var(--admin-border)' : 'none', paddingTop: isMobile ? '0.75rem' : 0
                      }}>
                        <div style={{ textAlign: isMobile ? 'left' : 'right' }}>
                          <div style={{ fontSize: isMobile ? '1.25rem' : '1.5rem', fontWeight: '950', color: 'var(--admin-brand)' }}>
                            ₱{Number(booking.total_amount || 0).toLocaleString()}
                          </div>
                          <div style={{ fontSize: '0.62rem', fontWeight: '900', color: 'var(--admin-text-secondary)', textTransform: 'uppercase' }}>TOTAL REVENUE</div>
                        </div>
                        <div style={{
                          padding: '0.4rem', borderRadius: 'var(--admin-radius-sm)', background: 'var(--admin-bg)',
                          border: '1px solid var(--admin-border)', display: 'flex', alignItems: 'center', justifyContent: 'center'
                        }}>
                          <ChevronRight size={16} color="var(--admin-brand)" />
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div style={{ textAlign: 'center', padding: '4rem', background: 'var(--admin-card)', borderRadius: 'var(--admin-radius)', border: '1px dashed var(--admin-border)' }}>
                  <Calendar size={48} style={{ color: 'var(--admin-text-secondary)', marginBottom: '1.25rem', opacity: 0.1 }} />
                  <h3 style={{ fontSize: '1.15rem', fontWeight: '950', color: 'var(--admin-text-primary)', textTransform: 'uppercase' }}>No system records found</h3>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      
      <style>{`
        .user-rectangle-card:hover { 
          transform: translateY(-2px); 
          border-color: var(--admin-brand); 
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15); 
        }
        .booking-history-card:hover {
          border-color: var(--admin-brand);
          transform: translateY(-2px);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
        }
      `}</style>
    </div>
  );
};

export default AdminUserManagement;
