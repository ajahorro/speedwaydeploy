/**
 * Minimal PDF drawing helpers shared by the transaction receipt and the
 * Statement of Account (no external dependencies; runs in Deno and Node).
 */
export type Rgb = [number, number, number]

export const RED: Rgb = [0.65, 0.11, 0.09]
export const DARK: Rgb = [0.07, 0.09, 0.13]
export const MUTED: Rgb = [0.42, 0.45, 0.50]
export const PALE: Rgb = [0.97, 0.97, 0.98]
export const RULE: Rgb = [0.88, 0.89, 0.91]

export const escapePdfText = (value: unknown): string => String(value ?? '')
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[^\x20-\x7E]/g, '?')
  .replace(/\\/g, '\\\\')
  .replace(/\(/g, '\\(')
  .replace(/\)/g, '\\)')

export const currency = (value: number): string =>
  `PHP ${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const dateLabel = (value?: string | null): string => {
  if (!value) return new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '-'
    : date.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
}

/** Approximate Helvetica advance widths (per 1pt of font size), close enough to right-align numbers and labels. */
const charWidth = (ch: string, bold: boolean): number => {
  if (ch === ' ') return 0.278
  if (/[0-9]/.test(ch)) return 0.556
  if (/[il.,:;'|!]/.test(ch)) return bold ? 0.3 : 0.25
  if (/[fjtrI()\-\/]/.test(ch)) return bold ? 0.36 : 0.33
  if (/[mwMW]/.test(ch)) return bold ? 0.9 : 0.85
  if (/[A-Z]/.test(ch)) return bold ? 0.72 : 0.67
  return bold ? 0.6 : 0.54
}
export const textWidth = (value: string, size: number, font = 'F1'): number =>
  [...String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')].reduce((w, ch) => w + charWidth(ch, font === 'F2'), 0) * size

export const text = (
  value: unknown,
  x: number,
  y: number,
  size = 10,
  font = 'F1',
  color: Rgb = DARK,
  align: 'left' | 'right' = 'left'
): string => {
  const safe = escapePdfText(value)
  const left = align === 'right' ? x - textWidth(String(value ?? ''), size, font) : x
  return `BT /${font} ${size} Tf ${color.join(' ')} rg 1 0 0 1 ${left.toFixed(2)} ${y.toFixed(2)} Tm (${safe}) Tj ET`
}

export const fillRect = (x: number, y: number, width: number, height: number, color: Rgb): string =>
  `${color.join(' ')} rg ${x} ${y} ${width} ${height} re f`

export const line = (x1: number, y1: number, x2: number, y2: number, color: Rgb, width = 0.7): string =>
  `${color.join(' ')} RG ${width} w ${x1} ${y1} m ${x2} ${y2} l S`

/** Assemble page content streams into a base64-encoded PDF (US Letter). */
export const assemblePdf = (pageContents: string[]): string => {
  const objects: string[] = []
  const pageObjectIds: number[] = []
  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  objects.push('') // The pages tree is filled after page objects are assigned.
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>')
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>')

  for (const content of pageContents) {
    const pageId = objects.length + 1
    const streamId = pageId + 1
    pageObjectIds.push(pageId)
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${streamId} 0 R >>`)
    objects.push(`<< /Length ${new TextEncoder().encode(content).length} >>\nstream\n${content}\nendstream`)
  }

  objects[1] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>`

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(new TextEncoder().encode(pdf).length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })

  const xrefStart = new TextEncoder().encode(pdf).length
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  })
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`

  const bytes = new TextEncoder().encode(pdf)
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary)
}

export const strokeRect = (x: number, y: number, width: number, height: number, color: Rgb = DARK, lineWidth = 0.8): string =>
  `${color.join(' ')} RG ${lineWidth} w ${x} ${y} ${width} ${height} re S`

/** Wrap text to lines of at most `max` characters, breaking on spaces. */
export const wrapText = (value: unknown, max: number): string[] => {
  const words = String(value ?? '').split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if ((current + ' ' + word).trim().length > max && current) { lines.push(current); current = word } else { current = (current + ' ' + word).trim() }
  }
  if (current) lines.push(current)
  return lines
}
