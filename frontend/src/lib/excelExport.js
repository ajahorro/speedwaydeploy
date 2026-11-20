// Shared builder for every "export report" button in the app. Replaces the old plain-CSV exports:
// a CSV opens in Excel as an unstyled grid the person has to widen and bold by hand first. This
// produces a real, already-formatted .xlsx — brand-colored headers, auto-sized columns so nothing
// is clipped, right-aligned money with two decimals, borders, and print-ready page setup (landscape,
// fit-to-width) — so the sheet looks the way a finished report should the moment it's opened.
const BRAND = 'FFC41F2B'; // Comar Garage red (ARGB; exceljs fills/fonts always want an alpha channel)
const HEADER_FILL = 'FFF3F4F6'; // light gray table-header row
const BORDER_COLOR = 'FFD1D5DB';
const MIN_COL = 10;
const MAX_COL = 60;

const thinBorder = { style: 'thin', color: { argb: BORDER_COLOR } };
const allBorders = { top: thinBorder, left: thinBorder, bottom: thinBorder, right: thinBorder };

const widthOf = (value) => String(value ?? '').length;

/**
 * One worksheet's content, in order. Each block is one of:
 *   { type: 'title', text }                                  — brand-red banner, bold white, merged across `span` cols
 *   { type: 'meta', rows: [[label, value], ...] }             — bold label, plain value, two columns
 *   { type: 'section', title, headers, rows, formats, span }  — gray section bar, header row, bordered data rows.
 *     `formats` is a per-column array: 'money' | 'int' | 'text' (default 'text').
 *   { type: 'spacer' }                                        — one blank row
 */
const renderSheet = (ws, { blocks, span = 8, landscape = true }) => {
  const colWidths = [];
  const trackWidth = (colIndex, value) => {
    colWidths[colIndex] = Math.max(colWidths[colIndex] || MIN_COL, Math.min(MAX_COL, widthOf(value) + 2));
  };

  let r = 1;
  for (const block of blocks) {
    if (block.type === 'title') {
      const row = ws.getRow(r);
      row.getCell(1).value = block.text;
      row.getCell(1).font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
      row.height = 24;
      ws.mergeCells(r, 1, r, span);
      for (let c = 1; c <= span; c += 1) row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
      row.getCell(1).alignment = { vertical: 'middle' };
      r += 1;
    } else if (block.type === 'meta') {
      for (const [label, value] of block.rows) {
        const row = ws.getRow(r);
        row.getCell(1).value = label;
        row.getCell(1).font = { bold: true };
        row.getCell(2).value = value;
        trackWidth(0, label);
        trackWidth(1, value);
        r += 1;
      }
    } else if (block.type === 'section') {
      const colSpan = block.span || (block.headers?.length ?? span);
      if (block.title) {
        const row = ws.getRow(r);
        row.getCell(1).value = block.title;
        row.getCell(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        for (let c = 1; c <= colSpan; c += 1) row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
        ws.mergeCells(r, 1, r, colSpan);
        row.height = 18;
        r += 1;
      }
      if (block.headers?.length) {
        const row = ws.getRow(r);
        block.headers.forEach((h, i) => {
          const cell = row.getCell(i + 1);
          cell.value = h;
          cell.font = { bold: true };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
          cell.border = allBorders;
          cell.alignment = { vertical: 'middle', wrapText: true };
          trackWidth(i, h);
        });
        row.height = 18;
        r += 1;
      }
      for (const dataRow of block.rows || []) {
        const row = ws.getRow(r);
        dataRow.forEach((value, i) => {
          const cell = row.getCell(i + 1);
          const format = block.formats?.[i] || 'text';
          if (format === 'money' && value !== '' && value !== null && value !== undefined) {
            cell.value = Number(value);
            cell.numFmt = '#,##0.00';
            cell.alignment = { horizontal: 'right' };
          } else if (format === 'int' && value !== '' && value !== null && value !== undefined) {
            cell.value = Number(value);
            cell.numFmt = '#,##0';
            cell.alignment = { horizontal: 'right' };
          } else {
            cell.value = value === null || value === undefined ? '' : String(value);
          }
          cell.border = allBorders;
          trackWidth(i, value);
        });
        r += 1;
      }
    } else if (block.type === 'spacer') {
      r += 1;
    }
  }

  colWidths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.pageSetup = {
    orientation: landscape ? 'landscape' : 'portrait',
    fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 }
  };
};

/** sheets: [{ name, blocks, span?, landscape? }]. Builds the workbook and triggers the browser download. */
export async function downloadWorkbook({ fileName, sheets }) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Comar Garage';
  wb.created = new Date();
  for (const sheet of sheets) {
    const name = String(sheet.name || 'Sheet').replace(/[[\]:*?/\\]/g, '_').slice(0, 31);
    // A frozen-pane view needs an actual split (ySplit/xSplit > 0) — state:'frozen' with ySplit:0
    // is invalid OOXML, which is why Excel was repairing every download by discarding the sheet view.
    const ws = wb.addWorksheet(name, sheet.freeze ? { views: [{ state: 'frozen', ySplit: sheet.freeze }] } : {});
    renderSheet(ws, sheet);
  }
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
