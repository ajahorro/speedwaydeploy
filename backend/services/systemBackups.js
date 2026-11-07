/**
 * System backups. A backup is one zip in the private 'system-backups' bucket:
 *   backup.json      every table, read back by Restore
 *   csv/<table>.csv  the same rows, readable in Excel
 * Listed in public.system_backups. Kept 3 months; one SCHEDULED backup per month (Manila time).
 */
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');

const BUCKET = 'system-backups';
const manilaStamp = (d = new Date()) => new Date(d.getTime() + 8 * 3600e3).toISOString(); // shifted so slicing gives Manila date/time
const monthStart = () => { const s = manilaStamp().slice(0, 7); return new Date(`${s}-01T00:00:00+08:00`).toISOString(); };

const toCsv = (rows) => {
  if (!rows.length) return '';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n')}`;
};

async function createBackup(db, { trigger, userId = null }) {
  const { data: snapshot, error } = await db.rpc('export_system_backup');
  if (error) throw error;
  const tables = snapshot.tables || {};
  const files = { 'backup.json': strToU8(JSON.stringify(snapshot)) };
  for (const [name, rows] of Object.entries(tables)) files[`csv/${name}.csv`] = strToU8(toCsv(rows));
  const zip = zipSync(files, { level: 9 });

  const stamp = manilaStamp().slice(0, 16).replace('T', '_').replace(':', '-');
  const filePath = `backup_${stamp}_${trigger.toLowerCase()}.zip`;
  const { error: upErr } = await db.storage.from(BUCKET).upload(filePath, zip, { contentType: 'application/zip', upsert: true });
  if (upErr) throw upErr;

  const row = {
    file_path: filePath, size_bytes: zip.byteLength, trigger, created_by: userId,
    table_count: Object.keys(tables).length,
    row_count: Object.values(tables).reduce((n, r) => n + r.length, 0),
  };
  const { data, error: insErr } = await db.from('system_backups').upsert(row, { onConflict: 'file_path' }).select().single();
  if (insErr) throw insErr;
  await keepNewest(db);
  return data;
}

/** Never more than MAX_KEPT backups: the oldest beyond that are removed (file and list entry). */
const MAX_KEPT = 6;
async function keepNewest(db) {
  const { data } = await db.from('system_backups').select('id, file_path').order('created_at', { ascending: false });
  const extra = (data || []).slice(MAX_KEPT);
  if (!extra.length) return;
  await db.storage.from(BUCKET).remove(extra.map((b) => b.file_path));
  await db.from('system_backups').delete().in('id', extra.map((b) => b.id));
}

/** Remove expired backups (file and list entry). */
async function purgeExpired(db) {
  const { data } = await db.from('system_backups').select('id, file_path').lt('expires_at', new Date().toISOString());
  if (!data?.length) return 0;
  await db.storage.from(BUCKET).remove(data.map((b) => b.file_path));
  await db.from('system_backups').delete().in('id', data.map((b) => b.id));
  return data.length;
}

/** This month's scheduled backup, made once. Safe to call any number of times. */
async function ensureMonthly(db) {
  await purgeExpired(db);
  const { count } = await db.from('system_backups').select('id', { count: 'exact', head: true })
    .eq('trigger', 'SCHEDULED').gte('created_at', monthStart());
  return count ? null : createBackup(db, { trigger: 'SCHEDULED' });
}

/** Safety backup first, then put the chosen backup back in one transaction. */
async function restoreBackup(db, id, userId) {
  const { data: backup, error } = await db.from('system_backups').select('*').eq('id', id).single();
  if (error) throw error;
  const { data: file, error: dlErr } = await db.storage.from(BUCKET).download(backup.file_path);
  if (dlErr) throw dlErr;
  const snapshot = JSON.parse(strFromU8(unzipSync(new Uint8Array(await file.arrayBuffer()))['backup.json']));
  if (snapshot.format !== 'comar-backup-v1') throw new Error('This file is not a Comar Garage backup.');

  const safety = await createBackup(db, { trigger: 'SAFETY', userId });
  const { data, error: rpcErr } = await db.rpc('restore_system_backup', { p_tables: snapshot.tables });
  if (rpcErr) throw rpcErr;
  return { backup, safety, ...data };
}

async function deleteBackup(db, id) {
  const { data: backup, error } = await db.from('system_backups').select('file_path').eq('id', id).single();
  if (error) throw error;
  await db.storage.from(BUCKET).remove([backup.file_path]);
  await db.from('system_backups').delete().eq('id', id);
  return backup;
}

const downloadUrl = async (db, id) => {
  const { data: backup, error } = await db.from('system_backups').select('file_path').eq('id', id).single();
  if (error) throw error;
  const { data, error: sErr } = await db.storage.from(BUCKET).createSignedUrl(backup.file_path, 60, { download: backup.file_path });
  if (sErr) throw sErr;
  return { url: data.signedUrl, fileName: backup.file_path };
};

module.exports = { createBackup, ensureMonthly, purgeExpired, restoreBackup, deleteBackup, downloadUrl, toCsv };
