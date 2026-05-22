/**
 * Keychain auth module for Assrt CLI.
 *
 * Reads the Claude Code OAuth token from macOS Keychain so users
 * who already have Claude Code installed get zero-setup auth.
 */

import { execSync } from "child_process";

const KEYCHAIN_SERVICE = "Claude Code-credentials";

interface ClaudeCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number | null;
    scopes: string[];
  };
}

export interface AuthCredential {
  /** The OAuth access token or API key. */
  token: string;
  type: "oauth" | "apiKey";
  /** Which model provider this credential authenticates. The agent loop
   *  branches on this to pick the SDK (Anthropic vs Gemini). */
  provider: "anthropic" | "gemini";
}

/**
 * Resolve credentials for the agent, in priority order:
 *   1. Claude Code OAuth token (macOS Keychain)  → Anthropic
 *   2. ANTHROPIC_API_KEY env var                 → Anthropic
 *   3. GEMINI_API_KEY env var                    → Gemini
 *
 * Anthropic is preferred because the agent loop is tuned for Claude's
 * tool-calling and most desktop users are already signed into Claude Code.
 * Gemini is the last-resort fallback so a user (or host app like Fazm) that
 * only has a Gemini key can still run tests — the Gemini provider path is
 * fully implemented in agent.ts, it just needs to be selected here.
 */
export function getCredential(): AuthCredential {
  // 1. Claude Code OAuth from Keychain (macOS, zero-setup default).
  //    Tried before ANTHROPIC_API_KEY so a stale shell env var never
  //    silently overrides a fresh Claude Code login.
  if (process.platform === "darwin") {
    try {
      const raw = execSync(
        `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
        { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      const parsed: ClaudeCredentials = JSON.parse(raw);
      const token = parsed?.claudeAiOauth?.accessToken;
      if (token) {
        console.error("[auth] Using Claude Code OAuth token from macOS Keychain (anthropic)");
        return { token, type: "oauth", provider: "anthropic" };
      }
    } catch {
      // Keychain entry not found, locked, or parse failed — fall through.
    }
  }

  // 2. ANTHROPIC_API_KEY env var (Linux/CI, or explicit personal key).
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    console.error("[auth] Using ANTHROPIC_API_KEY env var (anthropic)");
    return { token: anthropicKey, type: "apiKey", provider: "anthropic" };
  }

  // 3. GEMINI_API_KEY env var (last-resort fallback → Gemini provider).
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    console.error("[auth] Using GEMINI_API_KEY env var (gemini)");
    return { token: geminiKey, type: "apiKey", provider: "gemini" };
  }

  throw new Error(
    "No credentials found. Provide one of:\n" +
    "  - Log in to Claude Code (`claude` in terminal) to store an OAuth token in Keychain (preferred), or\n" +
    "  - Set ANTHROPIC_API_KEY (Anthropic fallback), or\n" +
    "  - Set GEMINI_API_KEY (Gemini fallback)."
  );
}
