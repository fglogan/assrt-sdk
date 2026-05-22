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
}

/**
 * Get the Claude Code OAuth token from macOS Keychain.
 * Users must have Claude Code installed and logged in.
 */
export function getCredential(): AuthCredential {
  // Priority order (changed in 0.5.1):
  //   1. Claude Code OAuth token from macOS Keychain — typical desktop user
  //      already has Claude Code installed, so this is the zero-setup default.
  //   2. ANTHROPIC_API_KEY env var — fallback for Linux/CI, or for users who
  //      explicitly prefer a personal API key over their Claude subscription.
  //
  // The previous order (env first) meant any stale ANTHROPIC_API_KEY left in a
  // user's shell would silently override their fresh OAuth login — surprising
  // and hard to debug. OAuth-first matches what most desktop users intuitively
  // expect when they're logged in to Claude Code.

  if (process.platform === "darwin") {
    try {
      const raw = execSync(
        `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
        { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      const parsed: ClaudeCredentials = JSON.parse(raw);
      const token = parsed?.claudeAiOauth?.accessToken;
      if (token) {
        console.error("[auth] Using Claude Code OAuth token from macOS Keychain");
        return { token, type: "oauth" };
      }
    } catch {
      // Keychain entry not found, locked, or parse failed — fall through to env.
    }
  }

  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey) {
    console.error("[auth] Using ANTHROPIC_API_KEY env var");
    return { token: envKey, type: "apiKey" };
  }

  throw new Error(
    "No credentials found. Either:\n" +
    "  - Log in to Claude Code (`claude` in terminal) to store an OAuth token in Keychain (preferred), or\n" +
    "  - Set the ANTHROPIC_API_KEY environment variable (fallback for Linux/CI)."
  );
}
