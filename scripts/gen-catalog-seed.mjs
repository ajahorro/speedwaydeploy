// Prints the SQL that loads the built-in service catalog (frontend/src/data/servicesCatalog.js) into
// public.catalog_builtin_services, so the database can check booking prices. The migration holds the
// output; scripts/verify-catalog-sync.mjs fails if the two ever differ.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICES_DATA } from '../frontend/src/data/servicesCatalog.js';

const q = (value) => `'${String(value).replace(/'/g, "''")}'`;

export const catalogRows = () => {
  const rows = [];
  for (const [category, services] of Object.entries(SERVICES_DATA)) {
    for (const service of services) {
      for (const [vehicle, price] of Object.entries(service.prices || {})) {
        const amount = Number(price);
        if (Number.isFinite(amount) && amount > 0) rows.push({ id: service.id, name: service.name, category, vehicle, price: amount });
      }
    }
  }
  return rows;
};

export const catalogInsertSql = () => {
  const rows = catalogRows();
  return `insert into public.catalog_builtin_services (service_id, name, category, vehicle_key, price) values\n${rows
    .map((r) => `  (${q(r.id)}, ${q(r.name)}, ${q(r.category)}, ${q(r.vehicle)}, ${r.price})`)
    .join(',\n')};`;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log(catalogInsertSql());
}
