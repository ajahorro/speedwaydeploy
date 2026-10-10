import React, { useMemo } from 'react';
import { Car, Trash2, Copy, Plus, ChevronRight, Info, Lock, X } from 'lucide-react';
import toast from '@/lib/toast';
import Step2Services from './Step2Services';
import { supabase } from '../../lib/supabase';
import { calculateBayUsage } from '../../utils/schedulingUtils';
import { fetchScheduleOccupancy } from '../../services/scheduleService';
import { SHOP_CONFIG, sanitizeVehiclePlate, sanitizeVehicleText } from '../../config/constants';
import { getBayCapacity } from '../../config/shopConfig';
import { useConfig } from '../../context/ConfigContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';

const NON_OCCUPYING_BOOKING_STATUSES = ['CANCELLED', 'RELEASED', 'COMPLETED'];
const NON_OCCUPYING_VEHICLE_STATUSES = ['COMPLETED', 'RELEASED'];

// Vehicles still holding a bay in [start, end), across ALL customers' bookings.
const fetchExternalVehicles = async (start, end) => {
  const occupancy = await fetchScheduleOccupancy(start.toISOString(), end.toISOString());
  return occupancy
    .filter(booking => !NON_OCCUPYING_BOOKING_STATUSES.includes(String(booking.status || '').toUpperCase()))
    .flatMap(booking => (booking.vehicles || []).filter(vehicle => !NON_OCCUPYING_VEHICLE_STATUSES.includes(String(vehicle.status || '').toUpperCase())));
};

const Step3FleetEditing = ({ bookingData, setBookingData, activeVehicleIndex, setActiveVehicleIndex, setCurrentStep, onNext, onBack, isSubTaskActive, setIsSubTaskActive, onCancel }) => {
  // useMemo so the identity is STABLE across renders: a bare `|| []` was a new
  // array every time bookingData.vehicles was unset, which made the effect below
  // re-run on every render.
  const vehicles = useMemo(() => bookingData.vehicles || [], [bookingData.vehicles]);

  const parseBookingDateTime = (date, time) => {
    const twelveHourTime = String(time || '').match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (twelveHourTime) {
      let hour = Number(twelveHourTime[1]);
      if (twelveHourTime[3].toUpperCase() === 'PM' && hour < 12) hour += 12;
      if (twelveHourTime[3].toUpperCase() === 'AM' && hour === 12) hour = 0;
      return new Date(`${date}T${String(hour).padStart(2, '0')}:${twelveHourTime[2]}:00`);
    }
    return new Date(`${date}T${time}`);
  };

  const [draftVehicle, setDraftVehicle] = React.useState(null);
  const [duplicateSourceIndex, setDuplicateSourceIndex] = React.useState(null);
  const [duplicateDetails, setDuplicateDetails] = React.useState({ brand: '', model: '', plateNumber: '' });
  const { settings: { MAX_BAYS: configuredMaxBays } } = useConfig();
  const [capacityContext, setCapacityContext] = React.useState({ maxBays: configuredMaxBays, externalVehicles: [], loading: true });

  React.useEffect(() => {
    let active = true;
    const refreshCapacityContext = async () => {
      const maxBays = await getBayCapacity();
      let externalVehicles = [];
      if (bookingData.date && bookingData.time) {
        const start = parseBookingDateTime(bookingData.date, bookingData.time);
        const currentDuration = vehicles.reduce((longest, vehicle) => Math.max(longest, (vehicle.services || []).reduce((sum, service) => sum + Number(service.durationMinutes || 60), 0)), 0) || 60;
        if (!Number.isNaN(start.getTime())) {
          const end = new Date(start.getTime() + (currentDuration + 60) * 60000);
          try {
            externalVehicles = await fetchExternalVehicles(start, end);
          } catch {
            // Unknown occupancy: keep the snapshot in its loading state so the
            // UI does not advertise capacity it could not verify. canAddVehicle
            // re-checks (and refuses) when the user actually adds a vehicle.
            return;
          }
        }
      }
      if (active) setCapacityContext({ maxBays, externalVehicles, loading: false });
    };
    refreshCapacityContext();
    return () => { active = false; };
  }, [bookingData.date, bookingData.time, vehicles]);

  const canAddTypeFromSnapshot = vehicleType => vehicles.length < capacityContext.maxBays && calculateBayUsage([
    ...capacityContext.externalVehicles,
    ...vehicles.map(vehicle => ({ type: vehicle.type || vehicle.vehicleType })),
    { type: vehicleType }
  ]) <= capacityContext.maxBays;
  const canAddAnyVehicle = capacityContext.loading || canAddTypeFromSnapshot('Sedan') || vehicles.some(vehicle => canAddTypeFromSnapshot(vehicle.type || 'Sedan'));

  const canAddVehicle = async (vehicleType, candidateServices = []) => {
    const maxBays = await getBayCapacity();
    if (vehicles.length >= maxBays) return false;
    let externalVehicles = [];
    const currentDuration = vehicles.reduce((longest, vehicle) => Math.max(longest, (vehicle.services || []).reduce((sum, service) => sum + Number(service.durationMinutes || 60), 0)), 0) || 60;
    const candidateDuration = (candidateServices || []).reduce((sum, service) => sum + Number(service.durationMinutes || 60), 0) || 60;
    const durationMinutes = Math.max(currentDuration, candidateDuration) + 60;
    if (bookingData.date && bookingData.time) {
      const start = parseBookingDateTime(bookingData.date, bookingData.time);
      if (Number.isNaN(start.getTime())) return false;
      const end = new Date(start.getTime() + durationMinutes * 60000);
      try {
        externalVehicles = await fetchExternalVehicles(start, end);
      } catch {
        return false;
      }
    }
    return calculateBayUsage([
      ...externalVehicles,
      ...vehicles.map(vehicle => ({ type: vehicle.type || vehicle.vehicleType })),
      { type: vehicleType }
    ]) <= maxBays && vehicles.length + 1 <= maxBays;
  };

  const handleAddVehicle = async () => {
    if (!(await canAddVehicle('Sedan'))) {
      toast.error('There is not enough bay capacity for another vehicle during the selected schedule.', { duration: 5000, style: { maxWidth: '480px' } });
      return;
    }

    const newDraft = {
      id: crypto.randomUUID(),
      type: '',
      brand: '',
      model: '',
      plateNumber: '',
      services: []
    };
    setDraftVehicle(newDraft);
    setIsSubTaskActive(true); 
  };

  const commitDraftVehicle = async () => {
    if (!draftVehicle) return;
    if (!(await canAddVehicle(draftVehicle.type || 'Sedan', draftVehicle.services || []))) {
      toast.error('This vehicle would exceed bay capacity during the selected schedule.');
      return;
    }
    setBookingData({
      ...bookingData,
      vehicles: [...vehicles, draftVehicle]
    });
    setDraftVehicle(null);
    setIsSubTaskActive(false);
    toast.success('New vehicle added to fleet!');
  };

  const updateDraftField = (updates) => {
    setDraftVehicle(prev => ({ ...prev, ...updates }));
  };

  const handleCopyVehicle = (e, index) => {
    e.stopPropagation(); // Don't trigger edit navigation
    const source = vehicles[index];
    setDuplicateSourceIndex(index);
    setDuplicateDetails({ brand: '', model: '', plateNumber: '' });
  };

  const confirmDuplicate = async () => {
    if (duplicateSourceIndex === null) return;
    const source = vehicles[duplicateSourceIndex];
    const brand = sanitizeVehicleText(duplicateDetails.brand).trim();
    const model = sanitizeVehicleText(duplicateDetails.model).trim();
    const plateNumber = sanitizeVehiclePlate(duplicateDetails.plateNumber).trim();
    if (!brand || !model || plateNumber.length < 4) {
      toast.error('Enter a brand, model, and a plate number with at least 4 letters or numbers.');
      return;
    }
    let capacityAvailable = false;
    try {
      capacityAvailable = await canAddVehicle(source.type, source.services || []);
    } catch (error) {
      console.error('Duplicate vehicle capacity check failed:', error);
      toast.error('Could not verify bay capacity. Please try again.');
      return;
    }
    if (!capacityAvailable) {
      toast.error('There is not enough bay capacity for another vehicle at this time.');
      return;
    }
    const copy = { ...source, id: crypto.randomUUID(), brand, model, plateNumber, garageVehicleId: undefined, fleetGroupId: source.fleetGroupId || null, locked: false, services: (source.services || []).map(service => ({ ...service, runtime_uuid: crypto.randomUUID() })) };
    setBookingData({ ...bookingData, vehicles: [...vehicles, copy] });
    setDuplicateSourceIndex(null);
    toast.success('Vehicle duplicated with the same services.');
  };

  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(null); // stores index to delete

  const handleDeleteVehicle = (e, index) => {
    e.stopPropagation();
    if (vehicles.length <= 1) return;
    setShowDeleteConfirm(index);
  };

  const confirmDelete = () => {
    if (showDeleteConfirm === null) return;
    const index = showDeleteConfirm;
    const updatedVehicles = vehicles.filter((_, i) => i !== index);
    setBookingData({ ...bookingData, vehicles: updatedVehicles });
    
    if (activeVehicleIndex >= updatedVehicles.length) {
      setActiveVehicleIndex(Math.max(0, updatedVehicles.length - 1));
    }
    setShowDeleteConfirm(null);
  };

  const [editingIndex, setEditingIndex] = React.useState(null);

  const handleEditVehicle = (index) => {
    setEditingIndex(index);
  };

  const handleSaveMetadata = () => {
    setEditingIndex(null);
    // Chrome supplied by the global <Toaster>; no inline override.
    toast.success('Vehicle details updated!');
  };

  const updateMetadataField = (field, value) => {
    if (editingIndex === null) return;
    const updatedVehicles = [...vehicles];
    updatedVehicles[editingIndex] = { ...updatedVehicles[editingIndex], [field]: value };
    setBookingData({ ...bookingData, vehicles: updatedVehicles });
  };

  if (isSubTaskActive && draftVehicle) {
    // Virtual state proxy to isolate draft from global fleet
    const virtualBookingData = { ...bookingData, vehicles: [draftVehicle] };
    const virtualSetBookingData = (updater) => setDraftVehicle((currentDraft) => {
      const currentBooking = { ...bookingData, vehicles: [currentDraft] };
      const nextBooking = typeof updater === 'function' ? updater(currentBooking) : updater;
      return nextBooking.vehicles[0];
    });

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <div style={{ padding: '0.5rem 1rem', background: 'rgba(var(--admin-brand-rgb), 0.1)', border: '1px solid var(--admin-brand)', borderRadius: '4px', width: 'fit-content', color: 'var(--admin-brand)', fontSize: '0.75rem', fontWeight: '900', textTransform: 'uppercase' }}>
          Configuring New Fleet Asset
        </div>
        <Step2Services 
          bookingData={virtualBookingData} 
          setBookingData={virtualSetBookingData} 
          activeVehicleIndex={0} 
          onNext={commitDraftVehicle} 
          onCancelNewVehicle={() => {
            setDraftVehicle(null);
            setIsSubTaskActive(false);
          }}
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div>
        <h2 style={{ margin: '0 0 0.5rem 0', fontSize: '1.5rem', fontWeight: '950', color: 'var(--admin-text-primary)' }}>Manage Your Fleet</h2>
        <p style={{ margin: 0, color: 'var(--admin-text-secondary)', fontSize: '0.9rem', fontWeight: '600' }}>
          Review the vehicles in this booking. You can copy details to add more vehicles or click a card to modify its services.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 350px), 1fr))', gap: '1.5rem', minWidth: 0 }}>
        {vehicles.map((v, idx) => (
          <div 
            key={v.id}
            onClick={() => handleEditVehicle(idx)}
            className="admin-card-hover"
            style={{
              background: 'var(--admin-bg)',
              border: '1px solid var(--admin-border)',
              borderRadius: 'var(--admin-radius-lg)',
              padding: '1.5rem',
              cursor: 'pointer',
              position: 'relative',
              transition: 'all 0.3s ease'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: 'rgba(var(--admin-brand-rgb), 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Car size={20} color="var(--admin-brand)" />
                </div>
                <div>
                  <div style={{ fontSize: '1rem', fontWeight: '950', color: 'var(--admin-text-primary)' }}>
                    {v.brand || 'Unnamed'} {v.model || 'Vehicle'}
                  </div>
                  <div style={{ fontSize: '0.75rem', fontWeight: '800', color: 'var(--admin-text-secondary)', textTransform: 'uppercase' }}>
                    {v.type || 'No Type'} • {v.plateNumber || 'No Plate'}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {canAddTypeFromSnapshot(v.type || 'Sedan') && <Button onClick={(e) => handleCopyVehicle(e, idx)} title="Copy Vehicle" variant="outline" size="icon">
                  <Copy size={16} />
                </Button>}
                <Button onClick={(e) => handleDeleteVehicle(e, idx)} disabled={vehicles.length <= 1} title="Remove Vehicle" variant="outline" size="icon" className="border-destructive/60 text-destructive hover:text-destructive">
                  <Trash2 size={16} />
                </Button>
              </div>
            </div>

            <div style={{ background: 'var(--admin-card)', borderRadius: 'var(--admin-radius-md)', padding: '1rem', border: '1px solid var(--admin-border)' }}>
              <div style={{ fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                Selected Services ({v.services?.length || 0})
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {v.services?.length > 0 ? (
                  v.services.map(s => (
                    <span key={s.id} style={{ fontSize: '0.7rem', fontWeight: '800', background: 'var(--admin-bg)', padding: '0.2rem 0.6rem', borderRadius: '4px', color: 'var(--admin-text-primary)', border: '1px solid var(--admin-border)' }}>
                      {s.name}
                    </span>
                  ))
                ) : (
                  <span style={{ fontSize: '0.7rem', color: 'var(--status-danger)', fontWeight: '800' }}>No services selected. Click to add.</span>
                )}
              </div>
            </div>

            <div style={{ position: 'absolute', right: '1.5rem', bottom: '1.5rem', opacity: 0.2 }}>
              <ChevronRight size={20} />
            </div>
          </div>
        ))}

        {/* Add Vehicle Placeholder Card */}
        {canAddAnyVehicle && <div
          onClick={handleAddVehicle}
          className="admin-card-hover"
          style={{
            border: '2px dashed var(--admin-border)',
            borderRadius: 'var(--admin-radius-lg)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '1rem',
            padding: '2rem',
            cursor: 'pointer',
            transition: 'all 0.3s ease',
            minHeight: '180px'
          }}
        >
          <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'rgba(var(--admin-brand-rgb), 0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Plus size={24} color="var(--admin-brand)" />
          </div>
          <div style={{ fontSize: '0.9rem', fontWeight: '950', color: 'var(--admin-brand)', textTransform: 'uppercase' }}>Add Another Vehicle</div>
        </div>}
      </div>

      <div style={{ background: 'rgba(var(--admin-info-rgb), 0.1)', border: '1px solid rgba(var(--admin-info-rgb), 0.2)', padding: '1rem', borderRadius: 'var(--admin-radius-md)', color: 'var(--admin-info)', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <Info size={20} />
        <span style={{ fontSize: '0.85rem', fontWeight: '600' }}>
          Multi-vehicle booking is active. Each vehicle can have different services and custom pricing.
        </span>
      </div>

      {/* Action Footer */}
      <div className="booking-step3-actions" style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid var(--admin-border)', paddingTop: '1.5rem', marginTop: '1rem', gap: '1rem' }}>
        <button
          className="booking-step3-back"
          onClick={onBack}
          style={{
            padding: '1rem 2rem',
            background: 'var(--admin-bg)',
            color: 'var(--admin-text-primary)',
            border: '1px solid var(--admin-border)',
            borderRadius: 'var(--admin-radius-md)',
            fontWeight: '950',
            fontSize: '1rem',
            cursor: 'pointer',
            textTransform: 'uppercase',
            letterSpacing: '1px'
          }}
        >
          Back
        </button>

        {onCancel && (
          <Button type="button" onClick={onCancel} variant="outline" className="border-destructive/60 text-destructive hover:text-destructive uppercase">
            Cancel
          </Button>
        )}
        <div style={{ position: 'relative' }}>
          {vehicles.length === 0 && (
            <div style={{ position: 'absolute', bottom: '100%', right: 0, marginBottom: '0.5rem', background: 'rgba(239, 68, 68, 0.1)', color: 'var(--status-danger)', padding: '0.4rem 0.8rem', borderRadius: '4px', fontSize: '0.65rem', fontWeight: '950', textTransform: 'uppercase', border: '1px solid rgba(239, 68, 68, 0.2)', whiteSpace: 'nowrap' }}>
              At least one vehicle required to proceed
            </div>
          )}
          <Button onClick={onNext} disabled={vehicles.length === 0} className="uppercase">
            Next: Review & Payment
          </Button>
        </div>
      </div>
      {/* Duplicate vehicle */}
      <Dialog open={duplicateSourceIndex !== null} onOpenChange={(open) => { if (!open) setDuplicateSourceIndex(null); }}>
        <DialogContent className="ui-root sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Duplicate vehicle</DialogTitle>
            <DialogDescription>Enter the new vehicle details. Its services will match the vehicle you duplicated.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Input aria-label="New vehicle brand" placeholder="Brand" value={duplicateDetails.brand} onChange={event => setDuplicateDetails(current => ({ ...current, brand: sanitizeVehicleText(event.target.value) }))} />
            <Input aria-label="New vehicle model" placeholder="Model" value={duplicateDetails.model} onChange={event => setDuplicateDetails(current => ({ ...current, model: sanitizeVehicleText(event.target.value) }))} />
            <Input aria-label="New vehicle plate number" minLength={4} pattern="[A-Za-z0-9]{4,}" placeholder="Plate number" value={duplicateDetails.plateNumber} onChange={event => setDuplicateDetails(current => ({ ...current, plateNumber: sanitizeVehiclePlate(event.target.value) }))} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDuplicateSourceIndex(null)}>Cancel</Button>
            <Button type="button" onClick={confirmDuplicate}>Add vehicle</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove vehicle */}
      <AlertDialog open={showDeleteConfirm !== null} onOpenChange={(open) => { if (!open) setShowDeleteConfirm(null); }}>
        <AlertDialogContent className="ui-root">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive"><Trash2 className="size-5" aria-hidden="true" />Remove Vehicle?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove <strong>{vehicles[showDeleteConfirm]?.brand} {vehicles[showDeleteConfirm]?.model}</strong> from this booking? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowDeleteConfirm(null)}>Cancel</Button>
            <Button type="button" variant="destructive" onClick={confirmDelete}>Yes, Delete</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit vehicle details */}
      <Dialog open={editingIndex !== null} onOpenChange={(open) => { if (!open) setEditingIndex(null); }}>
        <DialogContent className="ui-root max-h-[92dvh] overflow-y-auto sm:max-w-lg">
          {editingIndex !== null && vehicles[editingIndex] && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2"><Car className="size-5 text-primary" aria-hidden="true" />Edit Vehicle Details</DialogTitle>
                <DialogDescription>Refine your vehicle identification metadata.</DialogDescription>
              </DialogHeader>

              <div className="grid gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="edit-brand">Brand</Label>
                    <Input id="edit-brand" type="text" value={vehicles[editingIndex].brand} onChange={(e) => updateMetadataField('brand', sanitizeVehicleText(e.target.value))} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="edit-model">Model</Label>
                    <Input id="edit-model" type="text" value={vehicles[editingIndex].model} onChange={(e) => updateMetadataField('model', sanitizeVehicleText(e.target.value))} />
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="edit-plate">Plate Number</Label>
                  <Input id="edit-plate" type="text" value={vehicles[editingIndex].plateNumber} minLength={4} pattern="[A-Za-z0-9]{4,}" onChange={(e) => updateMetadataField('plateNumber', sanitizeVehiclePlate(e.target.value))} />
                </div>

                <div className="grid gap-2 rounded-md border border-dashed p-4 text-sm">
                  <p className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground"><Lock className="size-3" />Locked in steps 1 and 2</p>
                  <p>Type: <span className="text-muted-foreground">{vehicles[editingIndex].type}</span></p>
                  <p>Services: <span className="text-muted-foreground">{vehicles[editingIndex].services?.map(s => s.name).join(', ')}</span></p>
                  <p className="text-xs text-primary">Changing the type or services means checking the schedule again. Use the progress bar above to go back.</p>
                </div>
              </div>

              <DialogFooter>
                <Button type="button" onClick={handleSaveMetadata}>Save Vehicle Details</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Step3FleetEditing;
