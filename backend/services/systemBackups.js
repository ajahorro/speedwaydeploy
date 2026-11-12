/**
 * System backups. A backup is one zip in the private 'system-backups' bucket:
 *   backup.json      every table, read back by Restore
 *   backup.xlsx      the same rows as one Excel workbook, a sheet per table
 * Listed in public.system_backups. Kept 3 months; one SCHEDULED backup per month (Manila time).
 */
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');

const BUCKET = 'system-backups';
const manilaStamp = (d = new Date()) => new Date(d.getTime() + 8 * 3600e3).toISOString(); // shifted so slicing gives Manila date/time
const monthStart = () => { const s = manilaStamp().slice(0, 7); return new Date(`${s}-01T00:00:00+08:00`).toISOString(); };

const XML = (v) => String(v).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const colName = (i) => { let n = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) n = String.fromCharCode(65 + ((i - 1) % 26)) + n; return n; };

/** One Excel workbook for the whole snapshot: a Contents sheet, then one sheet per table (frozen header row). */
const toWorkbook = (tables) => {
  const names = new Set();
  const sheetName = (raw) => { // Excel: max 31 characters, unique, none of []:*?/\
    const base = raw.replace(/[[\]:*?/\\]/g, '_').slice(0, 31); let n = base, i = 1;
    while (names.has(n.toLowerCase())) n = `${base.slice(0, 28)}_${++i}`;
    names.add(n.toLowerCase()); return n;
  };
  const cell = (v, r, c, head) => {
    const ref = `${colName(c)}${r}`, st = head ? ' s="1"' : '';
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
    if (typeof v === 'boolean') return `<c r="${ref}" t="b"${st}><v>${v ? 1 : 0}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${XML((typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 32000))}</t></is></c>`;
  };
  const sheet = (grid, widths) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${grid.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cell(v, r + 1, c, r === 0)).join('')}</row>`).join('')}</sheetData></worksheet>`;

  const entries = Object.entries(tables);
  const sheets = [{ name: sheetName('Contents'), xml: sheet([['Table', 'Rows'], ...entries.map(([n, rows]) => [n, rows.length])], [36, 10]) }];
  for (const [name, rows] of entries) {
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const grid = cols.length ? [cols, ...rows.map((r) => cols.map((c) => r[c]))] : [['(no rows)']];
    sheets.push({ name: sheetName(name), xml: sheet(grid, (cols.length ? cols : ['']).map(() => 22)) });
  }
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${XML(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
  };
  sheets.forEach((sh, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sh.xml; });
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])), { level: 6 });
};

async function createBackup(db, { trigger, userId = null }) {
  const { data: snapshot, error } = await db.rpc('export_system_backup');
  if (error) throw error;
  const tables = snapshot.tables || {};
  const zip = zipSync({ 'backup.json': strToU8(JSON.stringify(snapshot)), 'backup.xlsx': toWorkbook(tables) }, { level: 9 });

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

/** Older backups were saved with one CSV per table: swap those for the single workbook the first time they are downloaded. */
async function ensureWorkbook(db, backup) {
  const { data: file, error } = await db.storage.from(BUCKET).download(backup.file_path);
  if (error) throw error;
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  if (files['backup.xlsx']) return;
  const snapshot = JSON.parse(strFromU8(files['backup.json']));
  const zip = zipSync({ 'backup.json': files['backup.json'], 'backup.xlsx': toWorkbook(snapshot.tables || {}) }, { level: 9 });
  const { error: upErr } = await db.storage.from(BUCKET).upload(backup.file_path, zip, { contentType: 'application/zip', upsert: true });
  if (upErr) throw upErr;
  await db.from('system_backups').update({ size_bytes: zip.byteLength }).eq('id', backup.id);
}

const downloadUrl = async (db, id) => {
  const { data: backup, error } = await db.from('system_backups').select('id, file_path').eq('id', id).single();
  if (error) throw error;
  await ensureWorkbook(db, backup);
  const { data, error: sErr } = await db.storage.from(BUCKET).createSignedUrl(backup.file_path, 60, { download: backup.file_path });
  if (sErr) throw sErr;
  return { url: data.signedUrl, fileName: backup.file_path };
};

module.exports = { createBackup, ensureMonthly, purgeExpired, restoreBackup, downloadUrl, toWorkbook };
