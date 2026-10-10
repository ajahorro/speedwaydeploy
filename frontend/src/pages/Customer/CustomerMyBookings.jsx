import React, { useState } from 'react';
import { Calendar, Search, ChevronRight, Car, RotateCw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useBookings } from '../../hooks/useBookings';
import { matchesSearchText } from '../../utils/searchMatch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';

const CustomerMyBookings = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { bookings, loading } = useBookings(user?.id);
  const [filter, setFilter] = useState('ALL');
  const [searchTerm, setSearchTerm] = useState('');

  const filteredBookings = bookings.filter(b => {
    const matchesFilter =
      filter === 'ALL' ||
      (filter === 'UPCOMING' && ['scheduled', 'confirmed', 'ongoing', 'in_progress'].includes(b.status?.toLowerCase())) ||
      (filter === 'PAST' && ['completed', 'released', 'cancelled', 'flagged_noshow'].includes(b.status?.toLowerCase()));

    const matchesSearch = matchesSearchText(searchTerm, b.id, b.status, (b.vehicles || []).map(v => [v.brand, v.model, v.plate_number, (v.services || []).map(s => s.service_name)]));

    return matchesFilter && matchesSearch;
  });

  const getStatusColor = (status) => {
    switch (status?.toLowerCase()) {
      case 'scheduled': return 'var(--admin-brand)';
      case 'confirmed': return 'var(--admin-info)';
      case 'ongoing':
      case 'in_progress': return '#a855f7';
      case 'completed': return 'var(--admin-success)';
      case 'cancelled':
      case 'flagged_noshow': return '#ef4444';
      default: return 'var(--admin-text-secondary)';
    }
  };

  const [showRebookModal, setShowRebookModal] = useState(false);
  const [selectedRebook, setSelectedRebook] = useState(null);

  const handleBookAgainClick = (booking) => {
    setSelectedRebook(booking);
    setShowRebookModal(true);
  };

  const confirmRebook = () => {
    if (selectedRebook) {
      const canReschedule = ['scheduled', 'confirmed'].includes(selectedRebook.status?.toLowerCase());
      sessionStorage.setItem('comar_rebook_data', JSON.stringify({
        ...selectedRebook,
        reschedule: canReschedule
      }));
      setShowRebookModal(false);
      navigate('/customer/book');
    }
  };

  return (
    <div className="ui-root pb-20">

      {/* Rebook / reschedule confirmation */}
      <AlertDialog open={showRebookModal} onOpenChange={setShowRebookModal}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <RotateCw className="size-5 text-primary" aria-hidden="true" />
              {['scheduled', 'confirmed'].includes(selectedRebook?.status?.toLowerCase()) ? 'Reschedule Booking?' : 'Fast-Track Rebook?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {['scheduled', 'confirmed'].includes(selectedRebook?.status?.toLowerCase())
                ? 'Your existing booking will return to Scheduled, release its staff allocation, and keep its payment history.'
                : <>Copying services and vehicle details. You will jump directly to the <strong>Schedule Selection</strong> step.</>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowRebookModal(false)}>Cancel</Button>
            <Button type="button" onClick={confirmRebook}>Let's Go</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="flex flex-col gap-8">

        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black uppercase tracking-tight">My Bookings</h1>
            <p className="mt-1 text-sm text-muted-foreground">Track and manage all your past and upcoming service appointments.</p>
          </div>
          <Button type="button" onClick={() => navigate('/customer/book')}>+ Book Appointment</Button>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap gap-3">
          <div className="relative min-w-[260px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              type="text"
              placeholder="Search by Booking ID or Vehicle..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>
          <Tabs value={filter} onValueChange={setFilter}>
            <TabsList>
              {['ALL', 'UPCOMING', 'PAST'].map(f => (
                <TabsTrigger key={f} value={f} className="px-4 text-xs font-bold">{f}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {/* Bookings list */}
        <div className="flex flex-col gap-3">
          {loading ? (
            <div className="grid gap-3" aria-busy="true">
              <Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" />
            </div>
          ) : filteredBookings.length === 0 ? (
            <div className="rounded-md border border-dashed px-6 py-14 text-center">
              <Calendar className="mx-auto mb-3 size-10 text-muted-foreground opacity-50" aria-hidden="true" />
              <p className="font-bold">No bookings found</p>
              <p className="text-sm text-muted-foreground">You don't have any {filter.toLowerCase()} appointments matching this criteria.</p>
            </div>
          ) : (
            filteredBookings.map(b => {
              const dt = b.start_datetime ? new Date(b.start_datetime) : null;
              const dateStr = dt ? dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'TBD';
              const timeStr = dt ? dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
              const vehicleLabel = b.vehicles?.length > 1
                ? `Fleet (${b.vehicles.length} units)`
                : b.vehicles?.[0] ? `${b.vehicles[0].brand} ${b.vehicles[0].model}` : 'N/A';
              const balance = Number(b.ledger?.outstanding_amount ?? b.total_amount ?? 0);
              const isCancelled = b.status?.toUpperCase() === 'CANCELLED';

              return (
                <Card
                  key={b.id}
                  onClick={() => navigate(`/customer/bookings/${b.id}`)}
                  className="grid cursor-pointer grid-cols-[repeat(auto-fit,minmax(150px,1fr))] items-center gap-5 rounded-md p-5 transition-colors hover:border-primary"
                >
                  <div>
                    <p className="text-xs font-semibold uppercase text-muted-foreground">Booking ID</p>
                    <p className="font-mono text-base font-bold">#{b.id.substring(0, 8).toUpperCase()}</p>
                    <Badge variant="outline" className="mt-2 uppercase" style={{ color: getStatusColor(b.status) }}>
                      {b.status?.toLowerCase() === 'flagged_noshow' ? 'FLAGGED NO-SHOW' : b.status?.replace(/_/g, ' ')}
                    </Badge>
                  </div>

                  <div>
                    <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground"><Calendar className="size-3.5" aria-hidden="true" /> Schedule</p>
                    <p className="text-sm font-semibold">{dateStr}</p>
                    <p className="text-sm text-muted-foreground">{timeStr}</p>
                  </div>

                  <div>
                    <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground"><Car className="size-3.5" aria-hidden="true" /> Vehicle</p>
                    <p className="text-sm font-semibold">{vehicleLabel}</p>
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <div className="flex-1">
                      <p className="text-xs font-semibold uppercase text-muted-foreground">Status</p>
                      {isCancelled ? (
                        <p className="text-sm font-bold text-destructive">CANCELLED</p>
                      ) : (
                        <p className={`text-sm font-bold ${balance === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-primary'}`}>
                          {balance === 0 ? 'FULLY PAID' : `BALANCE: ₱${balance.toLocaleString()}`}
                        </p>
                      )}
                    </div>

                    <div className="flex gap-2">
                      {['scheduled', 'confirmed', 'completed', 'cancelled'].includes(b.status?.toLowerCase()) && (
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-sm"
                          className="border-primary/60 text-primary hover:text-primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleBookAgainClick(b);
                          }}
                          title={['scheduled', 'confirmed'].includes(b.status?.toLowerCase()) ? 'Reschedule Booking' : 'Book Again'}
                          aria-label={['scheduled', 'confirmed'].includes(b.status?.toLowerCase()) ? 'Reschedule Booking' : 'Book Again'}
                        >
                          <RotateCw />
                        </Button>
                      )}
                      <span className="grid size-8 place-items-center rounded-md border" aria-hidden="true">
                        <ChevronRight className="size-4" />
                      </span>
                    </div>
                  </div>
                </Card>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

export default CustomerMyBookings;
