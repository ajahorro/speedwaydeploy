import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { subscribeTable } from '../../lib/realtimeHub';
import PageHeader from '../../components/PageHeader';
import { Bell, CheckCircle, Trash2, Search, AlertTriangle } from 'lucide-react';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import toast from '@/lib/toast';
import { logger } from '../../utils/logger';
import { useAuth } from '../../hooks/useAuth';
import NotificationDetailsModal from '../../components/NotificationDetailsModal';
import { isNotificationActionable, isRedundantStaffTechnicianAssignment } from '../../utils/notificationRouting';
import { matchesSearchText } from '../../utils/searchMatch';
import SeeMoreButton from '../../components/SeeMoreButton';
import { fetchVisiblePage } from '../../utils/pagedFetch';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const DeleteConfirmModal = ({ onConfirm, onCancel }) => (
  <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
    <AlertDialogContent className="ui-root">
      <AlertDialogHeader>
        <AlertDialogTitle className="flex items-center gap-2 text-destructive"><AlertTriangle className="size-5" aria-hidden="true" />Confirm Deletion</AlertDialogTitle>
        <AlertDialogDescription>Are you sure you want to delete this notification? This action cannot be undone.</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="button" variant="destructive" onClick={onConfirm}>Confirm Delete</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

const StaffNotifications = () => {
  const { user, profile } = useAuth();
  const userId = user?.id || profile?.id;
  const isMobile = useMediaQuery('(max-width: 1024px)');
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  // latest 10 first, then "See more" adds 10 at a time
  const [pageSize, setPageSize] = useState(10);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [selectedNotification, setSelectedNotification] = useState(null);

  const fetchNotifications = async () => {
    if (!userId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const page = await fetchVisiblePage({
        pageSize,
        fetchChunk: (from, to) => supabase.from('notifications').select('*').eq('user_id', userId).order('created_at', { ascending: false }).range(from, to),
        visible: (rows) => rows.filter((notification) =>
        isNotificationActionable(notification)
        && !isRedundantStaffTechnicianAssignment(notification)
        && notification.notification_type !== 'MESSAGE_RECEIVED'
        && !notification.title?.toLowerCase().includes('new message')
        )
      });
      setNotifications(page.rows);
      setHasMore(page.hasMore);
    } catch (err) {
      logger.error('Staff Notification Fetch Error', err);
      toast.error('Failed to load notifications.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNotifications();
    if (!userId) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchNotifications();
      }
    };

    window.addEventListener('visibilitychange', handleVisibilityChange);

    const stopRealtime = subscribeTable({ table: 'notifications', filter: `user_id=eq.${userId}` }, () => fetchNotifications());

    return () => {
      window.removeEventListener('visibilitychange', handleVisibilityChange);
      stopRealtime();
    };
  }, [userId, pageSize]);

  const handleMarkAsRead = async (id, silent = false) => {
    try {
      const { error } = await supabase.from('notifications').update({ is_read: true }).eq('id', id);
      if (error) throw error;
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
      if (!silent) toast.success('Notification acknowledged');
    } catch (err) {
      logger.error('Mark Read Error', err);
    }
  };

  const handleMarkAllAsRead = async () => {
    if (!userId) return;
    try {
      const { error } = await supabase.from('notifications').update({ is_read: true }).eq('user_id', userId).eq('is_read', false);
      if (error) throw error;
      setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
      toast.success('All notifications acknowledged');
    } catch (err) {
      logger.error('Mark All Read Error', err);
    }
  };

  const handleConfirmDelete = async () => {
    const id = confirmDeleteId;
    setConfirmDeleteId(null);
    try {
      const { error } = await supabase.from('notifications').delete().eq('id', id);
      if (error) throw error;
      setNotifications(prev => prev.filter(n => n.id !== id));
      toast.success('Notification removed');
    } catch (err) {
      logger.error('Delete Notification Error', err);
      toast.error('Failed to remove notification');
    }
  };

  const filteredNotifications = notifications.filter(n => {
    const matchesSearch = matchesSearchText(searchQuery, n.title, n.message);
    if (filter === 'UNREAD') return matchesSearch && !n.is_read;
    if (filter === 'READ') return matchesSearch && n.is_read;
    return matchesSearch;
  });

  return (
    <div className="ui-root flex flex-col gap-6 pb-8">
      {confirmDeleteId !== null && <DeleteConfirmModal onConfirm={handleConfirmDelete} onCancel={() => setConfirmDeleteId(null)} />}
      <NotificationDetailsModal
        notification={selectedNotification}
        onClose={() => setSelectedNotification(null)}
        onMarkRead={handleMarkAsRead}
        profile={profile}
      />

      <PageHeader badge="STAFF SIGNALS" title="NOTIFICATIONS" subtitle="Updates on your assigned tasks and system alerts." onRefresh={fetchNotifications}>
        <Button type="button" variant="outline" onClick={handleMarkAllAsRead} className="text-xs uppercase">Mark all as read</Button>
      </PageHeader>

      <div className={`flex gap-3 rounded-md border bg-card p-3 ${isMobile ? 'flex-col' : 'flex-row'}`}>
        <div className="relative w-full flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input type="text" placeholder="Search notifications..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" />
        </div>
        <Tabs value={filter} onValueChange={setFilter}>
          <TabsList>
            {['ALL', 'UNREAD', 'READ'].map(f => (
              <TabsTrigger key={f} value={f} className="px-4 text-xs font-bold">{f}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className="grid gap-3">
        {loading && notifications.length === 0 ? (
          [1, 2, 3].map(i => <Skeleton key={i} className="h-24 w-full" />)
        ) : filteredNotifications.length > 0 ? (
          filteredNotifications.map((notif) => (
            <Card
              key={notif.id}
              onClick={() => {
                setSelectedNotification(notif);
                if (!notif.is_read) handleMarkAsRead(notif.id, true);
              }}
              className={`cursor-pointer gap-0 rounded-md p-5 transition-colors hover:border-primary ${notif.is_read ? 'opacity-60' : 'border-l-4 border-l-primary'}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 gap-4">
                  <Bell className={`size-5 shrink-0 ${notif.is_read ? 'text-muted-foreground' : 'text-primary'}`} aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                      <span className={`font-bold ${notif.is_read ? 'text-muted-foreground' : 'text-primary'}`}>{notif.notification_type || 'SYSTEM'}</span>
                      <span className="text-muted-foreground">{new Date(notif.created_at).toLocaleString()}</span>
                    </div>
                    <p className="text-sm font-bold">{notif.title || 'Notification Received'}</p>
                    <p className="text-sm text-muted-foreground">{notif.message}</p>
                  </div>
                </div>
                <div onClick={(e) => e.stopPropagation()}>
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => setConfirmDeleteId(notif.id)} aria-label="Delete notification"><Trash2 /></Button>
                </div>
              </div>
            </Card>
          ))
        ) : (
          <div className="flex items-center gap-4 rounded-md border border-dashed bg-card px-5 py-4">
            <Bell className="size-5 shrink-0 opacity-30" aria-hidden="true" />
            <div>
              <p className="text-sm font-bold uppercase">All Clear</p>
              <p className="text-xs text-muted-foreground">No notifications match your current filter.</p>
            </div>
          </div>
        )}
        {hasMore && <SeeMoreButton loading={loading} onClick={() => setPageSize((n) => n + 10)} />}
      </div>
    </div>
  );
};

export default StaffNotifications;
