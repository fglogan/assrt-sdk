/**
 * Managed Chrome launcher.
 *
 * Spawns a real Google Chrome (or Chromium) process with
 * `--remote-debugging-port=<port>` so its CDP endpoint is reachable from the
 * host. This lets:
 *   1. Playwright MCP attach via `--cdp-endpoint http://127.0.0.1:<port>` to
 *      drive the same browser, and
 *   2. ai-browser-profile inject cookies/localStorage/IndexedDB over CDP into
 *      the same instance.
 *
 * Mirrors the architecture of fazm/acp-bridge/browser-harness-server.py
 * (`ensure_chrome()`), adapted to Node.
 *
 * Why a separate Chrome (instead of Playwright's bundled Chromium)?
 *   - Playwright's bundled Chromium doesn't expose CDP to the host by default.
 *   - ai-browser-profile injects via CDP HTTP, so we need a stable, externally
 *     reachable port we own.
 *   - Real Chrome aligns with what the user has installed and what
 *     ai-browser-profile reads from on disk.
 */

import { spawn, type ChildProcess } from "child_process";
import { existsSync, lstatSync, mkdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CHROME_BIN_CANDIDATES = [
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export const DEFAULT_MANAGED_PORT = 9655;
export const DEFAULT_MANAGED_USER_DATA_DIR = join(homedir(), ".assrt", "managed-chrome");

export interface ManagedChromeOptions {
  /** Remote debugging port. Default: 9655 (matches Fazm browser-harness). */
  port?: number;
  /** User data directory. Default: ~/.assrt/managed-chrome. */
  userDataDir?: string;
  /** Run headed (visible window). Default: false (headless via --headless=new). */
  headed?: boolean;
  /** Explicit Chrome binary path. Default: first match from candidate list or ASSRT_CHROME_BIN env. */
  chromeBin?: string;
  /** Max ms to wait for CDP port to come up. Default: 30_000. */
  startupTimeoutMs?: number;
}

export interface ManagedChromeHandle {
  /** PID of the spawned Chrome. Null when attached to an externally-running Chrome on this port. */
  pid: number | null;
  port: number;
  cdpUrl: string;
  userDataDir: string;
  chromeBin: string;
  headed: boolean;
  /** True when we attached to a pre-existing CDP server instead of spawning. */
  reused: boolean;
  /** Gracefully shut down: SIGTERM, then SIGKILL after ~2s. No-op when reused=true. */
  close(): Promise<void>;
}

export class ChromeNotFoundError extends Error {
  constructor() {
    super(
      "Google Chrome (or Chromium) not found. Install Chrome from " +
      "https://www.google.com/chrome/, or set ASSRT_CHROME_BIN to an explicit binary path.",
    );
    this.name = "ChromeNotFoundError";
  }
}

export class ChromeStartupTimeout extends Error {
  constructor(port: number, timeoutMs: number) {
    super(`Chrome did not expose CDP on port ${port} within ${timeoutMs}ms.`);
    this.name = "ChromeStartupTimeout";
  }
}

function resolveChromeBin(explicit?: string): string | null {
  if (explicit && existsSync(explicit)) return explicit;
  const env = process.env.ASSRT_CHROME_BIN?.trim();
  if (env && existsSync(env)) return env;
  for (const p of CHROME_BIN_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function isCdpAlive(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpAlive(port, 800)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new ChromeStartupTimeout(port, timeoutMs);
}

/** Remove stale singleton files in a user-data-dir.
 *  Chrome refuses to start when SingletonLock/SingletonSocket/SingletonCookie exist
 *  from a previous run that exited uncleanly. SingletonLock is a symlink so use lstatSync. */
function cleanSingletonLocks(userDataDir: string): void {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    const p = join(userDataDir, name);
    let exists = false;
    try { lstatSync(p); exists = true; } catch { /* not present */ }
    if (exists) {
      try { unlinkSync(p); } catch { /* best effort */ }
    }
  }
}

/** Launch a managed Chrome. If one is already running on the requested port, attach to it.
 *  Profile resolution order: explicit opts.userDataDir > ASSRT_MANAGED_USER_DATA_DIR env > DEFAULT_MANAGED_USER_DATA_DIR.
 *  The env var lets a host process (e.g. the Fazm desktop bundle) point assrt at a
 *  shared profile so cookies imported by other Fazm components show up here too. */
export async function launchManagedChrome(opts: ManagedChromeOptions = {}): Promise<ManagedChromeHandle> {
  const port = opts.port ?? DEFAULT_MANAGED_PORT;
  const envProfile = process.env.ASSRT_MANAGED_USER_DATA_DIR?.trim();
  const userDataDir = opts.userDataDir
    ?? (envProfile && envProfile.length > 0 ? envProfile : DEFAULT_MANAGED_USER_DATA_DIR);
  const headed = opts.headed ?? false;
  const startupTimeoutMs = opts.startupTimeoutMs ?? 30_000;

  const chromeBin = resolveChromeBin(opts.chromeBin);
  if (!chromeBin) throw new ChromeNotFoundError();

  const cdpUrl = `http://127.0.0.1:${port}`;

  // Attach if there's already a healthy Chrome on this port.
  if (await isCdpAlive(port)) {
    console.error(`[managed-chrome] attaching to existing Chrome on port ${port}`);
    return {
      pid: null,
      port,
      cdpUrl,
      userDataDir,
      chromeBin,
      headed,
      reused: true,
      close: async () => { /* not ours to kill */ },
    };
  }

  mkdirSync(userDataDir, { recursive: true });
  cleanSingletonLocks(userDataDir);

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-features=Translate,OptimizationHints,MediaRouter,ChromeWhatsNewUI",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-pings",
    "--password-store=basic",
    "--use-mock-keychain",
  ];
  if (!headed) args.push("--headless=new");

  console.error(`[managed-chrome] spawning ${chromeBin} port=${port} headed=${headed} userDataDir=${userDataDir}`);
  const child: ChildProcess = spawn(chromeBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  // Surface fatal errors during startup
  child.on("error", (err) => {
    console.error(`[managed-chrome] spawn error: ${err.message}`);
  });

  try {
    await waitForCdp(port, startupTimeoutMs);
  } catch (err) {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    throw err;
  }

  console.error(`[managed-chrome] CDP ready at ${cdpUrl} (pid=${child.pid})`);

  const handle: ManagedChromeHandle = {
    pid: child.pid ?? null,
    port,
    cdpUrl,
    userDataDir,
    chromeBin,
    headed,
    reused: false,
    close: async () => {
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
      // Give it ~2s to exit cleanly, then SIGKILL
      for (let i = 0; i < 20; i++) {
        if (child.exitCode != null || child.killed) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (child.exitCode == null && !child.killed) {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }
    },
  };
  return handle;
}
