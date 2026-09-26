/**
 * supabase/functions/_shared/deno-types.d.ts
 * ============================================================================
 * Minimal local typings for the Deno runtime surface these edge functions use.
 *
 * WHY THIS SHAPE
 * --------------
 * These functions run on the Supabase Edge Runtime (Deno), but the editor's
 * TypeScript service has no Deno lib loaded, so correct code is flagged:
 *
 *     Cannot find name 'Deno'.   (ts 2304)
 *
 * The obvious fix — `declare namespace Deno { ... }` — was tried and is WRONG
 * here. If the environment already provides a `Deno` declaration (or part of
 * one), a second `declare namespace Deno` MERGES into it, and the merged global
 * lib wins for the members it already defines. The symptoms of that collision
 * were:
 *
 *     Type 'String' has no call signatures.   (ts 2349)
 *     'delete' is a reserved word ...          (ts 1359)
 *     Cannot find name 'key'.                  (ts 2304)
 *
 * i.e. `string` stopped being read as a type and the parameters were re-parsed
 * as expressions. Redeclaring a global is not safe.
 *
 * WHAT THIS FILE DOES INSTEAD
 * ---------------------------
 * It declares ONLY the globals the functions actually reference. Both identifiers
 * are safe to declare globally:
 *
 *   * `Deno`     — no built-in lib defines it, so there is nothing to merge into.
 *   * `btoa`     — declared redundantly by design. It is legitimate to declare a
 *                  function that a lib may also declare; the duplicate signature
 *                  is identical, so it resolves rather than conflicts.
 *
 * `set`/`delete`/`get`/`toObject` are modelled as an interface's members, NOT as
 * bare functions. An interface member may legally be named `delete`, so the
 * keyword collision never arises — no quoting, no workaround.
 *
 * This file is TYPE-ONLY. A `.d.ts` emits nothing, so it has zero runtime effect
 * and the functions keep using the platform's real Deno when executed.
 *
 * NOTE: `interface` + `declare const` is used rather than `declare namespace`
 * specifically to avoid the global-merge problem described above.
 * ============================================================================
 */

/** The subset of `Deno.env` these functions use. */
interface DenoEnvironment {
  /** Reads an environment variable; `undefined` when unset. */
  get(key: string): string | undefined
  /** Sets an environment variable. */
  set(key: string, value: string): void
  /** Removes an environment variable. */
  delete(key: string): void
  /** Snapshot of every environment variable. */
  toObject(): Record<string, string>
}

/** The subset of the `Deno` global these functions use. */
interface DenoGlobal {
  readonly env: DenoEnvironment
  /** Serve an HTTP handler; the platform invokes it once per request. */
  serve(handler: (request: Request) => Response | Promise<Response>): void
  /** Read a file's contents as text. */
  readTextFile(path: string | URL): Promise<string>
  /** Exit the process with a status code. */
  exit(code?: number): never
}

declare const Deno: DenoGlobal

/**
 * Base64-encode a binary string. Provided by Deno, browsers and Node 16+, but
 * not by the ES lib the editor loads by default, so it is declared here to keep
 * the receipt-PDF path type-clean.
 */
declare function btoa(data: string): string