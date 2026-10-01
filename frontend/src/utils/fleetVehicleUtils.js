export const uniqueGarageVehicles = (vehicles = []) => [...new Map(
  vehicles.filter((vehicle) => vehicle?.id).map((vehicle) => [vehicle.id, vehicle])
).values()];

export const appendNewGarageVehicles = (current, additions) => {
  const existingIds = new Set(current.map((vehicle) => vehicle.garageVehicleId).filter(Boolean));
  const uniqueAdditions = [];

  for (const vehicle of additions) {
    const garageVehicleId = vehicle.garageVehicleId;
    if (!garageVehicleId || existingIds.has(garageVehicleId)) continue;
    existingIds.add(garageVehicleId);
    uniqueAdditions.push(vehicle);
  }

  return [...current, ...uniqueAdditions];
};