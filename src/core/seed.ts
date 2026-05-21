/**
 * Browser state seeding helper.
 *
 * Shells out to the `ai-browser-profile` Python package to copy cookies,
 * localStorage, or IndexedDB from a user's local browser profile (Chrome,
 * Arc, Brave, Edge) into a target browser via CDP.
 *
 * The target browser must be reachable at a CDP HTTP endpoint
 * (e.g. http://127.0.0.1:9655), which means it was launched with
 * `--remote-debugging-port=<port>` or Playwright MCP was attached via
 * `--cdp-endpoint`. Playwright MCP's default headless launch does NOT expose
 * a CDP endpoint to the host, so callers must use managed-Chrome mode or set
 * ASSRT_CDP_ENDPOINT.
 *
 * Python resolution order:
 *   1. ASSRT_ABP_PYTHON env var (explicit path to a python with ai_browser_profile installed)
 *   2. `python3` on PATH (must have `pip install ai-browser-profile`)
 *
 * Required Python deps in the resolved interpreter (gotchas the friendly
 * "module not found" hint does NOT cover, because they trip later):
 *   - websocket-client  → all three kinds use it for CDP injection over WS
 *   - cryptography      → Chromium Keychain decrypt
 *   - pycryptodome      → Chromium AES-CBC fallback
 *   - plyvel            → LevelDB reader, required for localstorage + indexeddb
 *                         (cookies path doesn't need it). plyvel doesn't build
 *                         on Python 3.14 yet; use 3.12 if you need localstorage
 *                         or indexeddb seeding.
 *
 * Exit-code semantics: rc=0 → injected ≥1 record; rc=2 → ran cleanly but
 * matched 0 records (e.g. domain filter had no hits); rc=1 → real error.
 * seed() reports ok=true only on rc=0 — callers wanting "no work" vs
 * "failure" must inspect returncode + stdout.
 *
 * Mirrors the Fazm browser-harness wrapper at
 * fazm/acp-bridge/browser-harness-server.py (bh_seed_cookies/localstorage/indexeddb).
 */

import { spawn } from "child_process";

export type SeedKind = "cookies" | "localstorage" | "indexeddb";

export interface SeedOptions {
  /** Source profile spec, e.g. "chrome:Default", "arc:Default", "brave:Profile 1". */
  source: string;
  /** Target CDP HTTP endpoint, e.g. "http://127.0.0.1:9655". */
  cdpUrl: string;
  /** Comma-separated filter. For cookies: host_key substrings (--domains).
   *  For localstorage/indexeddb: origin host substrings (--origins). */
  filter?: string;
  /** Seconds to wait after opening each tab before injecting (localstorage/indexeddb only). */
  loadWait?: number;
  /** Verbose mode (passes -v to the CLI). */
  verbose?: boolean;
  /** Override timeout in ms. Defaults vary by kind: cookies 60s, localstorage 180s, indexeddb 300s. */
  timeoutMs?: number;
}

export interface SeedResult {
  ok: boolean;
  kind: SeedKind;
  returncode: number;
  stdout: string;
  stderr: string;
  /** Set when the helper itself failed before the CLI ran (e.g. python missing). */
  error?: string;
}

const DEFAULT_TIMEOUTS: Record<SeedKind, number> = {
  cookies: 60_000,
  localstorage: 180_000,
  indexeddb: 300_000,
};

const PY_MODULES: Record<SeedKind, string> = {
  cookies: "ai_browser_profile.cookies",
  localstorage: "ai_browser_profile.localstorage",
  indexeddb: "ai_browser_profile.indexeddb",
};

/** The CLI flag used for filtering, which differs across modules. */
const FILTER_FLAG: Record<SeedKind, string> = {
  cookies: "--domains",
  localstorage: "--origins",
  indexeddb: "--origins",
};

function resolvePython(): string {
  return process.env.ASSRT_ABP_PYTHON?.trim() || "python3";
}

/** Run ai-browser-profile copy for a given kind. Captures stdout/stderr without piping to console. */
export async function seed(kind: SeedKind, opts: SeedOptions): Promise<SeedResult> {
  const python = resolvePython();
  const cdpUrl = opts.cdpUrl.trim();
  if (!cdpUrl) {
    return {
      ok: false,
      kind,
      returncode: -1,
      stdout: "",
      stderr: "",
      error: "cdpUrl is required",
    };
  }

  const args = [
    "-m",
    PY_MODULES[kind],
    "copy",
    "--from",
    opts.source,
    "--to",
    cdpUrl,
  ];
  if (opts.filter && opts.filter.trim()) {
    args.push(FILTER_FLAG[kind], opts.filter.trim());
  }
  if (opts.loadWait != null && (kind === "localstorage" || kind === "indexeddb")) {
    args.push("--load-wait", String(opts.loadWait));
  }
  if (opts.verbose) args.push("-v");

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUTS[kind];

  return new Promise<SeedResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(python, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const settle = (result: SeedResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      settle({
        ok: false,
        kind,
        returncode: -1,
        stdout,
        stderr,
        error: `seed ${kind} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });

    child.on("error", (err) => {
      clearTimeout(timer);
      const msg = (err as NodeJS.ErrnoException).code === "ENOENT"
        ? `python interpreter not found: ${python}. Install ai-browser-profile (\`pip install ai-browser-profile\`) or set ASSRT_ABP_PYTHON to a python that has it.`
        : err.message;
      settle({
        ok: false,
        kind,
        returncode: -1,
        stdout,
        stderr,
        error: msg,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const returncode = code ?? -1;
      // Common failure mode: package not installed in the resolved python. Surface a hint.
      if (returncode !== 0 && /No module named 'ai_browser_profile'/.test(stderr)) {
        settle({
          ok: false,
          kind,
          returncode,
          stdout,
          stderr,
          error: `ai_browser_profile not installed in ${python}. Install it with \`${python} -m pip install ai-browser-profile\` or set ASSRT_ABP_PYTHON to a python that has it.`,
        });
        return;
      }
      settle({
        ok: returncode === 0,
        kind,
        returncode,
        stdout,
        stderr,
      });
    });
  });
}

export const seedCookies = (opts: SeedOptions) => seed("cookies", opts);
export const seedLocalStorage = (opts: SeedOptions) => seed("localstorage", opts);
export const seedIndexedDB = (opts: SeedOptions) => seed("indexeddb", opts);
