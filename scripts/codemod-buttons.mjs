/**
 * One-off helper used while moving the customer and staff screens to shadcn/ui.
 * Turns hand-styled <button style={{...}}> elements into <Button variant size className>,
 * keeping every behaviour attribute (onClick, disabled, type, title, aria-*, key, ref ...) untouched.
 * Only layout-related inline styles (width, flex, margins, alignSelf ...) survive, as Tailwind classes.
 *
 *   node scripts/codemod-buttons.mjs <file> [more files]     (rewrites in place and prints what it changed)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const require = createRequire(path.join(root, 'frontend', 'package.json'));
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const BUTTON_IMPORT = "import { Button } from '@/components/ui/button';";
const LEGACY_CLASSES = new Set(['admin-card-hover']);

const layoutClassFor = (key, value) => {
  const rem = (v) => {
    if (typeof v !== 'string') return null;
    const m = v.match(/^(-?[\d.]+)rem$/);
    if (!m) return null;
    const n = Math.round(parseFloat(m[1]) * 4 * 100) / 100;
    return Number.isInteger(n) && n >= 0 && n <= 12 ? n : null;
  };
  switch (key) {
    case 'width': return value === '100%' ? 'w-full' : null;
    case 'flex': return value === 1 || value === '1' ? 'flex-1' : (typeof value === 'number' && value > 1 ? 'flex-[2]' : null);
    case 'alignSelf': return { 'flex-start': 'self-start', 'flex-end': 'self-end', center: 'self-center', stretch: 'self-stretch' }[value] || null;
    case 'marginTop': { const n = rem(value); return n != null ? `mt-${n}` : null; }
    case 'marginBottom': { const n = rem(value); return n != null ? `mb-${n}` : null; }
    case 'marginLeft': return value === 'auto' ? 'ml-auto' : (rem(value) != null ? `ml-${rem(value)}` : null);
    case 'marginRight': return rem(value) != null ? `mr-${rem(value)}` : null;
    default: return null;
  }
};

const run = (file) => {
  let source = fs.readFileSync(file, 'utf8');
  const crlf = source.includes('\r\n');
  if (crlf) source = source.replace(/\r\n/g, '\n');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const edits = [];
  const log = [];

  traverse(ast, {
    JSXElement(p) {
      const opening = p.node.openingElement;
      if (opening.name.type !== 'JSXIdentifier' || opening.name.name !== 'button') return;
      const attrs = opening.attributes;
      const styleAttr = attrs.find((a) => a.type === 'JSXAttribute' && a.name.name === 'style');
      const classAttr = attrs.find((a) => a.type === 'JSXAttribute' && a.name.name === 'className');
      const styleText = styleAttr ? source.slice(styleAttr.start, styleAttr.end) : '';
      const hasSpread = attrs.some((a) => a.type === 'JSXSpreadAttribute');
      // A button carrying its own CSS class (mobile layouts, cards) is left exactly as it is.
      if (classAttr && (classAttr.value?.type !== 'StringLiteral' || classAttr.value.value.split(/s+/).some((c) => c && !LEGACY_CLASSES.has(c)))) { log.push(`  line ${opening.loc.start.line}: SKIPPED (own class)`); return; }
      // A look that depends on state (selected / active) must keep its own styling.
      if (/(background|border|borderColor|color):s*[^,}]*?[^,}]*:/.test(styleText) && !/opacity/.test(styleText.split(/(background|border|borderColor|color):/)[0])) { log.push(`  line ${opening.loc.start.line}: SKIPPED (state-dependent look)`); return; }
      // Card-like buttons (rows of rich content) are not shadcn Buttons: leave them alone.
      const richChild = p.node.children.some((c) => c.type === 'JSXElement' && c.openingElement.name.type === 'JSXIdentifier' && /^[a-z]/.test(c.openingElement.name.name) && !['svg', 'span', 'strong', 'small', 'b'].includes(c.openingElement.name.name));
      if (richChild || /textAlign:s*'left'/.test(styleText) || /justifyContent:s*'space-between'/.test(styleText)) { log.push(`  line ${opening.loc.start.line}: SKIPPED (card-like)`); return; }

      // variant
      const solidBrand = /background:\s*(\(?[^,]*\?\s*)?'var\(--admin-brand\)'|background:\s*'#E61E2A'|background:\s*'var\(--admin-brand\)'/.test(styleText) && !/background:\s*'transparent'/.test(styleText);
      const solidDanger = /background:\s*'var\(--status-danger\)'/.test(styleText);
      const dangerLook = /status-danger|#ef4444/.test(styleText);
      const brandBorder = /border:\s*[`'"][^`'"]*admin-brand/.test(styleText) && /background:\s*'(transparent|var\(--admin-bg\))'/.test(styleText);
      const noBorder = /border:\s*(0|'none'|"none"|'0')/.test(styleText);
      const transparentBg = /background:\s*'(transparent|none)'/.test(styleText);

      let variant = 'outline';
      let extra = '';
      if (solidDanger) variant = 'destructive';
      else if (solidBrand) variant = 'default';
      else if (dangerLook) { variant = 'outline'; extra = 'border-destructive/60 text-destructive hover:text-destructive'; }
      else if (brandBorder) { variant = 'outline'; extra = 'border-primary text-primary hover:text-primary'; }
      else if (/background:s*'(none|transparent)'/.test(styleText) && noBorder && /color:s*'var(--admin-brand)'/.test(styleText)) { variant = 'link'; extra = 'h-auto p-0'; }
      else if (transparentBg && noBorder) variant = 'ghost';

      // size
      const fontMatch = styleText.match(/fontSize:\s*['"]?([\d.]+)(rem|px)?/);
      const fontRem = fontMatch ? (fontMatch[2] === 'px' ? parseFloat(fontMatch[1]) / 16 : parseFloat(fontMatch[1])) : null;
      const textChildren = p.node.children.filter((c) => (c.type === 'JSXText' && c.value.trim()) || c.type === 'JSXExpressionContainer').length;
      const onlyIcon = textChildren === 0 && p.node.children.some((c) => c.type === 'JSXElement');
      let size = fontRem !== null && fontRem < 0.75 ? 'sm' : 'default';
      if (onlyIcon) size = 'icon';

      // layout classes from a literal style object
      const layout = [];
      if (styleAttr?.value?.type === 'JSXExpressionContainer' && styleAttr.value.expression.type === 'ObjectExpression') {
        for (const prop of styleAttr.value.expression.properties) {
          if (prop.type !== 'ObjectProperty') continue;
          const key = prop.key.name || prop.key.value;
          const v = prop.value;
          const literal = v.type === 'StringLiteral' || v.type === 'NumericLiteral' ? v.value : undefined;
          if (literal === undefined) continue;
          const cls = layoutClassFor(key, literal);
          if (cls) layout.push(cls);
        }
      }
      if (/textTransform:\s*'uppercase'/.test(styleText)) layout.push('uppercase');

      // keep every attribute except style, legacy class names and mouse-hover style handlers
      const kept = [];
      let classText = null;
      for (const a of attrs) {
        if (a === styleAttr) continue;
        if (a.type === 'JSXAttribute' && /^onMouse(Enter|Leave)$/.test(a.name.name)) continue;
        if (a === classAttr) {
          if (a.value?.type === 'StringLiteral') {
            const rest = a.value.value.split(/\s+/).filter((c) => c && !LEGACY_CLASSES.has(c));
            if (rest.length) classText = rest.join(' ');
          } else {
            kept.push(source.slice(a.start, a.end)); // dynamic className: keep untouched
            classText = undefined;
          }
          continue;
        }
        kept.push(source.slice(a.start, a.end));
      }
      const classes = [classText, extra, ...layout].filter(Boolean).join(' ');
      const parts = [...kept, `variant="${variant}"`];
      if (size !== 'default') parts.push(`size="${size}"`);
      if (classes && classText !== undefined) parts.push(`className="${classes}"`);
      if (hasSpread) return; // never touch a button that spreads props

      const selfClosing = opening.selfClosing;
      const newOpening = `<Button ${parts.join(' ')}${selfClosing ? ' />' : '>'}`;
      edits.push({ start: opening.start, end: opening.end, text: newOpening });
      if (p.node.closingElement) edits.push({ start: p.node.closingElement.start, end: p.node.closingElement.end, text: '</Button>' });
      log.push(`  line ${opening.loc.start.line}: variant=${variant} size=${size}${classes ? ` class="${classes}"` : ''}`);
    }
  });

  if (!edits.length) { console.log(`${file}: no buttons`); return; }
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) source = source.slice(0, e.start) + e.text + source.slice(e.end);
  if (!source.includes(BUTTON_IMPORT)) {
    const lines = source.split('\n');
    let last = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^import .* from /.test(lines[i]) || /^} from /.test(lines[i])) last = i;
      if (/^(const|export|function) /.test(lines[i])) break;
    }
    lines.splice(last + 1, 0, BUTTON_IMPORT);
    source = lines.join('\n');
  }
  if (crlf) source = source.replace(/\n/g, '\r\n');
  fs.writeFileSync(file, source);
  console.log(`${file}: ${log.length} buttons converted`);
  log.forEach((l) => console.log(l));
};

process.argv.slice(2).forEach(run);
