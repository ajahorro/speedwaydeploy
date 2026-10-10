import React, { useState, useEffect, useCallback } from 'react';
import { Car, Plus, Settings, CheckCircle2, ChevronRight, Loader2, Trash2, Calendar, History, AlertCircle, X, Layers } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useUI } from '../../context/UIContext';
import { supabase } from '../../lib/supabase';
import {
  fetchUserGarage,
  fetchFleetGroups,
  createFleetGroup,
  updateFleetGroup,
  addVehicleToGarage,
  updateGarageVehicle,
  addVehicleToFleet,
  setFleetVehicles,
  deleteGarageVehicle,
  fetchVehicleHistory
} from '../../services/garageService';
import toast from '@/lib/toast';
import { sanitizeVehiclePlate, sanitizeVehicleText } from '../../config/constants';
import { useConfig } from '../../context/ConfigContext';
import { calculateBayUsage } from '../../utils/schedulingUtils';
import { getBayCapacity } from '../../config/shopConfig';
import { useConfirmAction } from '../../hooks/useConfirmAction';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Card } from '@/components/ui/card';

// Radix Select cannot hold an empty value, so "no fleet" travels as this marker inside the dialog only.
const NO_FLEET = '__none__';

const CustomerGarage = () => {
  const { confirmThen } = useConfirmAction();
  const { user } = useAuth();
  // Vehicle categories configured in the Business Hub.
  const { settings: { VEHICLE_TYPES: vehicleTypeOptions } } = useConfig();
  const [vehicles, setVehicles] = useState([]);
  const [fleetGroups, setFleetGroups] = useState([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false);
  const [selectedFleetVehicleIds, setSelectedFleetVehicleIds] = useState([]);
  const [isCreatingFleet, setIsCreatingFleet] = useState(false);
  const [selectedFleetGroup, setSelectedFleetGroup] = useState(null);
  const [isEditingFleet, setIsEditingFleet] = useState(false);
  const [fleetEditName, setFleetEditName] = useState('');
  const [fleetEditVehicleIds, setFleetEditVehicleIds] = useState([]);
  const [isSavingFleet, setIsSavingFleet] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [selectedVehicle, setSelectedVehicle] = useState(null);
  const [historyData, setHistoryData] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const { openModal, showToast } = useUI();

  const [formData, setFormData] = useState({
    type: 'Sedan',
    brand: '',
    model: '',
    plateNumber: '',
    isPrimary: false
  });

  const loadGarage = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data = await fetchUserGarage(user.id);
      const groups = await fetchFleetGroups(user.id);

      // Fetch "Last Service" for each vehicle
      const vehiclesWithHistory = await Promise.all(data.map(async (v) => {
        const history = await fetchVehicleHistory(v.plate_number);
        const lastService = history.length > 0 ? new Date(history[0].created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
        return { ...v, lastService };
      }));

      setVehicles(vehiclesWithHistory);
      setFleetGroups(groups);
    } catch (error) {
      console.error('Garage Load Error:', error);
      toast.error('Failed to synchronize garage records.');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadGarage();
  }, [loadGarage]);

  const handleOpenAdd = () => {
    setSelectedVehicle(null);
    setFormData({ type: 'Sedan', brand: '', model: '', plateNumber: '', isPrimary: false, fleetGroupId: fleetGroups[0]?.id || '' });
    setIsModalOpen(true);
  };

  const handleOpenEdit = (vehicle) => {
    setSelectedVehicle(vehicle);
    setFormData({
      type: vehicle.type,
      brand: vehicle.brand,
      model: vehicle.model,
      plateNumber: vehicle.plate_number,
      isPrimary: vehicle.is_primary,
      fleetGroupId: vehicle.fleet_group_id || ''
    });
    setIsModalOpen(true);
  };

  const handleViewHistory = async (vehicle) => {
    setSelectedVehicle(vehicle);
    setIsHistoryOpen(true);
    setLoadingHistory(true);
    try {
      const history = await fetchVehicleHistory(vehicle.plate_number);
      setHistoryData(history);
    } catch (error) {
      toast.error('Failed to load service history.');
    } finally {
      setLoadingHistory(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const toastId = toast.loading(selectedVehicle ? 'Updating vehicle...' : 'Adding vehicle to fleet...');
    try {
      if (selectedVehicle) {
        await updateGarageVehicle(selectedVehicle.id, formData);
        toast.success('Vehicle Updated', { id: toastId });
      } else {
        await addVehicleToGarage(user.id, formData);
        toast.success('Vehicle Added to Garage', { id: toastId });
      }
      setIsModalOpen(false);
      loadGarage();
    } catch (error) {
      toast.error(error.message || 'Operation failed', { id: toastId });
    }
  };

  const handleCreateGroup = async () => {
    if (!newGroupName.trim() || selectedFleetVehicleIds.length === 0) {
      toast.error('Enter a fleet name and select at least one vehicle.');
      return;
    }
    setIsCreatingFleet(true);
    try {
      const maxBays = await getBayCapacity().catch(() => NaN);
      if (!Number.isFinite(maxBays) || maxBays <= 0) {
        throw new Error('Fleet capacity is unavailable. Ask an administrator to configure the number of bays.');
      }
      const selectedVehicles = vehicles.filter(vehicle => selectedFleetVehicleIds.includes(vehicle.id));
      if (calculateBayUsage(selectedVehicles) > maxBays) {
        throw new Error(`This fleet needs ${calculateBayUsage(selectedVehicles)} bays, but the shop currently has ${maxBays}.`);
      }
      const group = await createFleetGroup(user.id, newGroupName);
      await setFleetVehicles(group.id, selectedFleetVehicleIds);
      setNewGroupName('');
      setSelectedFleetVehicleIds([]);
      setIsGroupModalOpen(false);
      await loadGarage();
      toast.success('Fleet created with selected vehicles');
    } catch (error) {
      toast.error(error.message || 'Failed to create fleet group');
    } finally {
      setIsCreatingFleet(false);
    }
  };

  const handleOpenGroup = () => {
    if (vehicles.length === 0) return;
    setNewGroupName('');
    setSelectedFleetVehicleIds([]);
    setIsGroupModalOpen(true);
  };

  const handleStartFleetEdit = () => {
    setFleetEditName(selectedFleetGroup.name);
    setFleetEditVehicleIds((selectedFleetGroup.vehicles || []).map(vehicle => vehicle.id));
    setIsEditingFleet(true);
  };

  const handleSaveFleetEdit = async () => {
    if (!fleetEditName.trim()) return toast.error('Enter a fleet name.');
    setIsSavingFleet(true);
    try {
      const maxBays = await getBayCapacity().catch(() => NaN);
      if (!Number.isFinite(maxBays) || maxBays <= 0) {
        throw new Error('Fleet capacity is unavailable. Ask an administrator to configure the number of bays.');
      }
      const selectedVehicles = vehicles.filter(vehicle => fleetEditVehicleIds.includes(vehicle.id));
      if (calculateBayUsage(selectedVehicles) > maxBays) {
        throw new Error(`This fleet needs ${calculateBayUsage(selectedVehicles)} bays, but the shop currently has ${maxBays}.`);
      }
      await updateFleetGroup(selectedFleetGroup.id, fleetEditName);
      await setFleetVehicles(selectedFleetGroup.id, fleetEditVehicleIds);
      setIsEditingFleet(false);
      setSelectedFleetGroup(null);
      await loadGarage();
      toast.success('Fleet updated');
    } catch (error) {
      toast.error(error.message || 'Failed to update fleet');
    } finally {
      setIsSavingFleet(false);
    }
  };

  const handleDeleteFleet = () => {
    openModal({
      title: 'Delete Fleet?',
      message: `Delete "${selectedFleetGroup.name}"? The vehicles will remain in your garage but will no longer belong to this fleet.`,
      confirmText: 'Delete Fleet',
      cancelText: 'Keep Fleet',
      type: 'danger',
      onConfirm: async () => {
        try {
          const { error } = await supabase
            .from('fleet_groups')
            .delete()
            .eq('id', selectedFleetGroup.id)
            .eq('owner_id', user.id);
          if (error) throw error;
          setSelectedFleetGroup(null);
          setIsEditingFleet(false);
          await loadGarage();
          showToast('Fleet deleted', 'success');
        } catch (error) {
          showToast(error.message || 'Failed to delete fleet', 'error');
        }
      }
    });
  };

  const handleDelete = (vehicleId) => {
    openModal({
      title: 'Remove Vehicle',
      message: 'Are you sure you want to remove this vehicle from your garage? This action cannot be undone.',
      confirmText: 'Remove Unit',
      cancelText: 'Cancel',
      type: 'danger',
      onConfirm: async () => {
        try {
          await deleteGarageVehicle(vehicleId);
          showToast('Vehicle Removed', 'success');
          loadGarage();
        } catch (error) {
          showToast('Failed to remove vehicle', 'error');
        }
      }
    });
  };

  if (loading) {
    return (
      <div className="ui-root flex flex-col gap-6 pb-20" aria-busy="true">
        <p className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Syncing Fleet Records...</p>
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
          <Skeleton className="h-48" /><Skeleton className="h-48" /><Skeleton className="h-48" />
        </div>
      </div>
    );
  }

  return (
    <div className="ui-root flex flex-col gap-8 pb-20">

      {/* Header */}
      <div>
        <h1 className="text-3xl font-black uppercase tracking-tight">My Garage</h1>
        <p className="mt-1 text-sm text-muted-foreground">Manage your registered vehicles for high-fidelity booking tracking.</p>
      </div>

      {/* Fleet groups */}
      <section className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold uppercase">Fleet Groups</h2>
            <p className="text-xs text-muted-foreground">{vehicles.length === 0 ? 'Add at least one vehicle to your garage before creating a fleet.' : 'Select a fleet to view its assigned vehicles.'}</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={handleOpenGroup} disabled={vehicles.length === 0} title={vehicles.length === 0 ? 'Add a vehicle first' : undefined} className="border-primary text-primary hover:text-primary">
            <Plus /> Create Fleet
          </Button>
        </div>
        <div className="min-h-32 rounded-md border border-dashed bg-card p-4">
          {fleetGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">No fleet groups created yet.</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,230px))] gap-3">
              {fleetGroups.map(group => {
                const groupVehicleCount = group.vehicles?.length || 0;
                return (
                  <button key={group.id} type="button" onClick={() => setSelectedFleetGroup(group)} className="flex min-h-[74px] items-center justify-between gap-2 rounded-md border bg-card p-3 text-left transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-ring">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Layers className="size-[17px] shrink-0 text-primary" aria-hidden="true" />
                      <span className="min-w-0">
                        <strong className="block truncate text-sm">{group.name}</strong>
                        <small className="block text-xs text-muted-foreground">{groupVehicleCount} vehicle{groupVehicleCount === 1 ? '' : 's'}</small>
                      </span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Vehicles */}
      <section className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-bold uppercase">Vehicles</h2>
          <Button type="button" size="sm" onClick={handleOpenAdd}><Plus /> Add New Vehicle</Button>
        </div>
        <div className="min-h-72 rounded-md border border-dashed bg-card p-4">
          {vehicles.length === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center">
              <Car className="size-14 text-muted-foreground opacity-30" strokeWidth={1} aria-hidden="true" />
              <div>
                <h3 className="font-bold">Your Garage is Empty</h3>
                <p className="text-sm text-muted-foreground">Add your first vehicle to speed up your booking process.</p>
              </div>
              <Button type="button" variant="outline" onClick={handleOpenAdd} className="border-primary text-primary hover:text-primary">Get started</Button>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,280px))] gap-3">
              {vehicles.map(vehicle => (
                <Card key={vehicle.id} className={`relative gap-3 overflow-hidden rounded-md p-4 ${vehicle.is_primary ? 'border-primary' : ''}`}>
                  {vehicle.is_primary && <span className="absolute inset-y-0 left-0 w-1.5 bg-primary" aria-hidden="true" />}

                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="grid size-10 shrink-0 place-items-center rounded-md border bg-muted/40">
                        <Car className={`size-5 ${vehicle.is_primary ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden="true" />
                      </div>
                      <div className="min-w-0">
                        <p className="break-words text-sm font-bold">{vehicle.brand} {vehicle.model}</p>
                        <p className="text-xs font-semibold uppercase text-muted-foreground">{vehicle.type}</p>
                      </div>
                    </div>
                    {vehicle.is_primary && <Badge variant="outline" className="shrink-0 gap-1 border-primary/40 text-primary uppercase"><CheckCircle2 className="size-3" />Primary</Badge>}
                  </div>

                  <div className="grid grid-cols-2 gap-3 rounded-md border bg-muted/40 p-3">
                    <div>
                      <p className="text-[0.65rem] font-semibold uppercase text-muted-foreground">Plate Number</p>
                      <p className="break-all text-sm font-bold tracking-wider">{vehicle.plate_number}</p>
                    </div>
                    <div>
                      <p className="text-[0.65rem] font-semibold uppercase text-muted-foreground">Last Session</p>
                      <p className={`text-sm font-semibold ${vehicle.lastService ? 'text-primary' : 'text-muted-foreground'}`}>{vehicle.lastService || 'NEW ENTRY'}</p>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => handleViewHistory(vehicle)} className="flex-1 uppercase"><History /> Service Log</Button>
                    <Button type="button" variant="outline" size="icon-sm" onClick={() => handleOpenEdit(vehicle)} aria-label="Edit vehicle"><Settings /></Button>
                    <Button type="button" variant="outline" size="icon-sm" onClick={() => handleDelete(vehicle.id)} aria-label="Delete vehicle" className="border-destructive/40 text-destructive hover:text-destructive"><Trash2 /></Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Fleet vehicles / edit fleet */}
      <Dialog open={Boolean(selectedFleetGroup)} onOpenChange={(open) => { if (!open) { setSelectedFleetGroup(null); setIsEditingFleet(false); } }}>
        <DialogContent className="ui-root max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          {selectedFleetGroup && (
            <>
              <DialogHeader>
                <p className="text-xs font-semibold uppercase tracking-wider text-primary">Fleet Group</p>
                <DialogTitle>{isEditingFleet ? 'Edit Fleet' : selectedFleetGroup.name}</DialogTitle>
                <DialogDescription>{isEditingFleet ? 'Rename the fleet and manage its assigned vehicles.' : 'Vehicles assigned to this fleet.'}</DialogDescription>
              </DialogHeader>

              {!isEditingFleet && (
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={handleStartFleetEdit}>Edit Fleet</Button>
                  <Button type="button" variant="outline" size="sm" onClick={handleDeleteFleet} className="text-destructive hover:text-destructive"><Trash2 />Delete fleet</Button>
                </div>
              )}

              {isEditingFleet ? (
                <>
                  <div className="grid gap-1.5">
                    <Label htmlFor="fleet-edit-name">Fleet name</Label>
                    <Input id="fleet-edit-name" autoFocus value={fleetEditName} onChange={event => setFleetEditName(event.target.value)} />
                  </div>
                  <div className="grid max-h-[42dvh] gap-2 overflow-y-auto sm:grid-cols-2">
                    {vehicles.map(vehicle => {
                      const isSelected = fleetEditVehicleIds.includes(vehicle.id);
                      return (
                        <label key={vehicle.id} className={`flex cursor-pointer items-center gap-3 rounded-md border p-3 ${isSelected ? 'border-primary bg-primary/5' : ''}`}>
                          <Checkbox checked={isSelected} onCheckedChange={() => setFleetEditVehicleIds(current => isSelected ? current.filter(id => id !== vehicle.id) : [...current, vehicle.id])} />
                          <span className="min-w-0 text-sm">
                            <strong className="block truncate">{vehicle.brand} {vehicle.model}</strong>
                            <small className="text-muted-foreground">{vehicle.plate_number} · {vehicle.type}</small>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setIsEditingFleet(false)}>Cancel</Button>
                    <Button type="button" disabled={isSavingFleet} onClick={() => confirmThen({ title: 'Save fleet changes?', message: 'The fleet name and vehicles will be updated.', confirmText: 'Save changes' }, handleSaveFleetEdit)}>{isSavingFleet ? 'Saving...' : 'Save Fleet'}</Button>
                  </DialogFooter>
                </>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(selectedFleetGroup.vehicles || []).map(vehicle => (
                      <div key={vehicle.id} className="rounded-md border p-4">
                        <div className="flex items-center gap-3">
                          <Car className="size-5 shrink-0 text-primary" />
                          <div className="min-w-0">
                            <strong className="block break-words text-sm">{vehicle.brand} {vehicle.model}</strong>
                            <span className="text-xs text-muted-foreground">{vehicle.type}</span>
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-3 border-t pt-3">
                          <div>
                            <small className="block text-[0.65rem] font-semibold uppercase text-muted-foreground">Plate</small>
                            <span className="text-sm font-semibold tracking-wider">{vehicle.plate_number}</span>
                          </div>
                          <div>
                            <small className="block text-[0.65rem] font-semibold uppercase text-muted-foreground">Last session</small>
                            <span className={`text-sm font-semibold ${vehicle.lastService ? 'text-primary' : 'text-muted-foreground'}`}>{vehicle.lastService || 'New entry'}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {(selectedFleetGroup.vehicles || []).length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No vehicles are currently assigned to this fleet.</p>}
                </>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Create fleet */}
      <Dialog open={isGroupModalOpen} onOpenChange={setIsGroupModalOpen}>
        <DialogContent className="ui-root max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Fleet</DialogTitle>
            <DialogDescription>Group vehicles for faster multi-vehicle bookings.</DialogDescription>
          </DialogHeader>
          <form onSubmit={event => { event.preventDefault(); confirmThen({ title: 'Create this fleet?', message: 'The selected vehicles will be grouped into a fleet.', confirmText: 'Create fleet' }, () => handleCreateGroup()); }} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="fleet-new-name">Fleet name</Label>
              <Input id="fleet-new-name" autoFocus required value={newGroupName} onChange={event => setNewGroupName(event.target.value)} placeholder="e.g. Family vehicles" />
            </div>
            <div className="grid gap-1.5">
              <Label>Choose vehicles</Label>
              {vehicles.length === 0 ? (
                <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">Add vehicles to your garage before creating a fleet.</p>
              ) : (
                <div className="grid max-h-[35dvh] gap-2 overflow-y-auto sm:grid-cols-2">
                  {vehicles.map(vehicle => {
                    const isSelected = selectedFleetVehicleIds.includes(vehicle.id);
                    return (
                      <label key={vehicle.id} className={`flex cursor-pointer items-center gap-3 rounded-md border p-3 ${isSelected ? 'border-primary bg-primary/5' : ''}`}>
                        <Checkbox checked={isSelected} onCheckedChange={() => setSelectedFleetVehicleIds(current => isSelected ? current.filter(id => id !== vehicle.id) : [...current, vehicle.id])} />
                        <span className="min-w-0 text-sm">
                          <strong className="block truncate">{vehicle.brand} {vehicle.model}</strong>
                          <small className="text-muted-foreground">{vehicle.plate_number} · {vehicle.type}</small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIsGroupModalOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={isCreatingFleet || selectedFleetVehicleIds.length === 0}>{isCreatingFleet ? 'Creating...' : 'Create Fleet'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add / edit vehicle */}
      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="ui-root max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{selectedVehicle ? 'Edit Vehicle Specs' : 'Register New Vehicle'}</DialogTitle>
            <DialogDescription>{selectedVehicle ? 'Update the details of this vehicle.' : 'Add a vehicle to your garage.'}</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); confirmThen({ title: 'Save this vehicle?', message: 'The vehicle details will be saved to your garage.', confirmText: 'Save vehicle' }, () => handleSubmit(e)); }} className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label>Vehicle Type</Label>
                <Select value={formData.type} onValueChange={(value) => setFormData({ ...formData, type: value })}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {vehicleTypeOptions.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Fleet Group</Label>
                <Select value={formData.fleetGroupId || NO_FLEET} onValueChange={(value) => setFormData({ ...formData, fleetGroupId: value === NO_FLEET ? '' : value })}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_FLEET}>Ungrouped</SelectItem>
                    {fleetGroups.map(group => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="vehicle-plate">Plate Number</Label>
                <Input id="vehicle-plate" type="text" placeholder="ABC1234" required value={formData.plateNumber} onChange={(e) => setFormData({ ...formData, plateNumber: sanitizeVehiclePlate(e.target.value) })} className="font-semibold tracking-widest" />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="vehicle-brand">Brand / Make</Label>
              <Input id="vehicle-brand" type="text" placeholder="e.g. Honda" required value={formData.brand} onChange={(e) => setFormData({ ...formData, brand: sanitizeVehicleText(e.target.value) })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="vehicle-model">Model Name</Label>
              <Input id="vehicle-model" type="text" placeholder="e.g. Civic Type R" required value={formData.model} onChange={(e) => setFormData({ ...formData, model: sanitizeVehicleText(e.target.value) })} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIsModalOpen(false)}>Cancel</Button>
              <Button type="submit">{selectedVehicle ? 'Save Changes' : 'Register Vehicle'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Service history */}
      <Dialog open={isHistoryOpen} onOpenChange={setIsHistoryOpen}>
        <DialogContent className="ui-root flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="border-b px-6 py-4">
            <DialogTitle>Service Log</DialogTitle>
            <DialogDescription>{selectedVehicle?.brand} {selectedVehicle?.model} • {selectedVehicle?.plate_number}</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {loadingHistory ? (
              <div className="grid gap-3" aria-busy="true">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : historyData.length === 0 ? (
              <div className="py-12 text-center text-muted-foreground">
                <History className="mx-auto mb-3 size-10 opacity-60" />
                <p className="text-sm font-semibold text-foreground">No detailing history found</p>
                <p className="text-sm">When this vehicle completes a service, it will appear here.</p>
              </div>
            ) : (
              <div className="grid gap-3">
                {historyData.map((entry, idx) => (
                  <div key={idx} className="rounded-md border p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[0.65rem] font-semibold uppercase text-muted-foreground">Session date</p>
                        <p className="text-sm font-semibold">{new Date(entry.booking?.start_datetime).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
                      </div>
                      <Badge variant="outline" className={`uppercase ${entry.status === 'completed' ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : 'border-purple-500/40 text-purple-600 dark:text-purple-400'}`}>{entry.status}</Badge>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {(entry.services || []).map((s, sIdx) => (
                        <Badge key={sIdx} variant="secondary" className="uppercase">{s.service_name}</Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <p className="border-t px-6 py-3 text-center text-xs text-muted-foreground">Showing automated fleet history log from Comar Garage.</p>
        </DialogContent>
      </Dialog>

    </div>
  );
};

export default CustomerGarage;
