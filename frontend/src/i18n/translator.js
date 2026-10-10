/**
 * Runtime translator. The components are written in English and never edited for translation: when the chosen
 * language is not English, this walks the page, looks every piece of visible text up in the translation catalog
 * (src/i18n/<language>.json, made from the source by scripts/i18n-extract.mjs) and swaps it in place. It keeps
 * watching the page, so text that React renders later is translated too.
 *
 * - Text is changed in place (never wrapped in new elements), so React keeps working normally.
 * - Text with variables is stored as "Booked on {}" and matched as a pattern.
 * - Anything not in the catalog (names, plate numbers, amounts, text typed by people) stays as it is.
 * - Going back to English restores the original text exactly.
 */
const ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'];
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'CODE', 'PRE']);
const SKIP_SELECTOR = '[translate="no"], .notranslate, [data-no-translate], [contenteditable="true"]';

let exact = new Map();
let patterns = [];
let observer = null;
let frame = 0;
const pendingNodes = new Set();
const textState = new WeakMap(); // text node -> { original, output }
const attrState = new WeakMap(); // element -> { [attribute]: { original, output } }

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const loadCatalog = (catalog) => {
  exact = new Map();
  patterns = [];
  for (const [source, target] of Object.entries(catalog || {})) {
    if (typeof target !== 'string' || !target) continue;
    if (source.includes('{}')) {
      const regex = new RegExp(`^${source.split('{}').map(escapeRegExp).join('(.+?)')}$`);
      patterns.push({ regex, target, length: source.length });
    } else {
      exact.set(source, target);
    }
  }
  patterns.sort((a, b) => b.length - a.length); // the most specific pattern wins
};

const translateText = (value) => {
  const key = value.replace(/\s+/g, ' ').trim();
  if (!key || !/[A-Za-z]/.test(key)) return null;
  let out = exact.get(key);
  if (out === undefined && key === key.toUpperCase()) {
    // ALL-CAPS text (status labels, headings styled in capitals): find the normal-case entry and capitalise the result
    const sentence = key.charAt(0) + key.slice(1).toLowerCase();
    const title = key.toLowerCase().replace(/(^|[s/(-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
    const hit = exact.get(sentence) ?? exact.get(title);
    if (hit !== undefined) out = hit.toLocaleUpperCase('fil');
  }
  if (out === undefined && key === key.toLowerCase()) {
    // all-lowercase text (labels shown with a CSS capitalise): find the capitalised entry, keep the lowercase look
    const sentence = key.charAt(0).toUpperCase() + key.slice(1);
    const title = key.replace(/(^|[s/(-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
    const hit = exact.get(sentence) ?? exact.get(title);
    if (hit !== undefined) out = hit.charAt(0).toLocaleLowerCase('fil') + hit.slice(1);
  }
  if (out === undefined) {
    for (const pattern of patterns) {
      const match = pattern.regex.exec(key);
      if (match) {
        let i = 0;
        out = pattern.target.replace(/\{\}/g, () => match[++i] ?? '');
        break;
      }
    }
  }
  if (out === undefined) return null;
  const lead = value.match(/^\s*/)[0];
  const trail = value.match(/\s*$/)[0];
  return `${lead}${out}${trail}`;
};

const skipped = (node) => {
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!el) return true;
  if (SKIP_TAGS.has(el.tagName)) return true;
  return Boolean(el.closest(SKIP_SELECTOR));
};

const processText = (node) => {
  if (skipped(node)) return;
  const current = node.nodeValue;
  const state = textState.get(node);
  if (state && current === state.output) return; // our own change
  const out = translateText(current);
  if (out === null) { textState.delete(node); return; }
  textState.set(node, { original: current, output: out });
  node.nodeValue = out;
};

const processAttributes = (el) => {
  if (skipped(el)) return;
  const states = attrState.get(el) || {};
  for (const name of ATTRIBUTES) {
    if (!el.hasAttribute(name)) continue;
    const current = el.getAttribute(name);
    if (states[name] && current === states[name].output) continue;
    const out = translateText(current);
    if (out === null) { delete states[name]; continue; }
    states[name] = { original: current, output: out };
    el.setAttribute(name, out);
  }
  attrState.set(el, states);
};

const processTree = (root) => {
  if (root.nodeType === 3) { processText(root); return; }
  if (root.nodeType !== 1) return;
  if (skipped(root)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) { processText(node); node = walker.nextNode(); }
  processAttributes(root);
  root.querySelectorAll(ATTRIBUTES.map((a) => `[${a}]`).join(',')).forEach(processAttributes);
};

const flush = () => {
  frame = 0;
  const nodes = [...pendingNodes];
  pendingNodes.clear();
  for (const node of nodes) {
    if (!node.isConnected) continue;
    if (node.nodeType === 3) processText(node); else processTree(node);
  }
};
const schedule = (node) => {
  pendingNodes.add(node);
  if (!frame) frame = requestAnimationFrame(flush);
};

export const startTranslating = (catalog) => {
  loadCatalog(catalog);
  if (observer) observer.disconnect();
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') mutation.addedNodes.forEach((node) => schedule(node));
      else if (mutation.type === 'characterData') schedule(mutation.target);
      else if (mutation.type === 'attributes') schedule(mutation.target);
    }
  });
  processTree(document.body);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
};

export const stopTranslating = () => {
  if (observer) { observer.disconnect(); observer = null; }
  if (frame) { cancelAnimationFrame(frame); frame = 0; }
  pendingNodes.clear();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const state = textState.get(node);
    if (state && node.nodeValue === state.output) node.nodeValue = state.original;
    textState.delete(node);
    node = walker.nextNode();
  }
  document.body.querySelectorAll(ATTRIBUTES.map((a) => `[${a}]`).join(',')).forEach((el) => {
    const states = attrState.get(el);
    if (!states) return;
    for (const [name, state] of Object.entries(states)) {
      if (el.getAttribute(name) === state.output) el.setAttribute(name, state.original);
    }
    attrState.delete(el);
  });
};
