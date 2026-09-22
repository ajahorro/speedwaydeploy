/**
 * Minimal ESM resolver shim so the app's extensionless relative imports
 * (e.g. `../config/constants`) resolve when running tests under plain Node.
 * Vite does this automatically at build time; Node does not.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
    const base = new URL(specifier, context.parentURL);
    for (const ext of ['.js', '.jsx', '/index.js']) {
      const candidate = new URL(base.href + ext);
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}