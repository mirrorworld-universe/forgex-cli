/**
 * ForgeX CLI Anonymous Usage Telemetry
 *
 * - Async fire-and-forget, does not block command execution
 * - Failures are silently ignored, no impact on user experience
 * - Supports opt-out: `forgex config set telemetry false` or `FORGEX_NO_TELEMETRY=1`
 * - Does not collect any private keys, addresses, transaction content, or other sensitive data
 */

import { PostHog } from 'posthog-node';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FORGEX_DIR, ensureConfigDir, loadConfig } from './config.js';

// ============================================================
// Constants
// ============================================================

const POSTHOG_API_KEY = 'phc_nYSQzmljgTrNqmuHonEWEjGXzX97B9w81D9DzsiVYlX';
const POSTHOG_HOST = 'https://eu.i.posthog.com';
const ANONYMOUS_ID_FILE = path.join(FORGEX_DIR, '.anonymous-id');

// ============================================================
// Anonymous ID Management
// ============================================================

/** Get or generate a persistent anonymous ID (not linked to any user identity) */
function getAnonymousId(): string {
  ensureConfigDir();
  try {
    if (fs.existsSync(ANONYMOUS_ID_FILE)) {
      return fs.readFileSync(ANONYMOUS_ID_FILE, 'utf-8').trim();
    }
  } catch {
    // ignore
  }

  const id = randomUUID();
  try {
    fs.writeFileSync(ANONYMOUS_ID_FILE, id, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // ignore
  }
  return id;
}

// ============================================================
// Install Source Detection
// ============================================================

function detectInstallSource(): string {
  // npm install
  if (process.env.npm_config_registry || process.env.npm_execpath) {
    return 'npm';
  }

  const execPath = process.argv[1] || '';

  // Homebrew
  if (execPath.includes('/opt/homebrew/') || execPath.includes('/usr/local/Cellar/')) {
    return 'brew';
  }

  // Global npm install (in node_modules)
  if (execPath.includes('node_modules')) {
    return 'npm-global';
  }

  return 'manual';
}

// ============================================================
// Telemetry Toggle
// ============================================================

function isTelemetryEnabled(): boolean {
  // Environment variables take priority
  if (process.env.FORGEX_NO_TELEMETRY === '1' || process.env.DO_NOT_TRACK === '1') {
    return false;
  }

  // Disabled by default in CI environments
  if (process.env.CI === 'true' || process.env.CI === '1') {
    return false;
  }

  // Config file
  try {
    const config = loadConfig();
    if ((config as unknown as Record<string, unknown>).telemetry === false) {
      return false;
    }
  } catch {
    // ignore
  }

  return true;
}

// ============================================================
// PostHog Client (lazy initialization)
// ============================================================

let _client: PostHog | null = null;

function getClient(): PostHog | null {
  if (!isTelemetryEnabled()) return null;

  if (!_client) {
    _client = new PostHog(POSTHOG_API_KEY, {
      host: POSTHOG_HOST,
      flushAt: 20,
      flushInterval: 10000,
      requestTimeout: 3000,
    });
    // Swallow all PostHog errors to avoid affecting CLI main flow
    _client.on?.('error', () => {});
  }

  return _client;
}

// ============================================================
// Public API
// ============================================================

/** Track command execution event */
export function trackCommand(command: string, properties?: Record<string, unknown>): void {
  try {
    const client = getClient();
    if (!client) return;

    client.capture({
      distinctId: getAnonymousId(),
      event: 'cli_command',
      properties: {
        command,
        version: getCliVersion(),
        os: os.platform(),
        os_version: os.release(),
        arch: os.arch(),
        node_version: process.version,
        install_source: detectInstallSource(),
        ...properties,
      },
    });
  } catch {
    // Tracking failure does not affect user operations
  }
}

/** Track custom event */
export function trackEvent(event: string, properties?: Record<string, unknown>): void {
  try {
    const client = getClient();
    if (!client) return;

    client.capture({
      distinctId: getAnonymousId(),
      event,
      properties: {
        version: getCliVersion(),
        os: os.platform(),
        ...properties,
      },
    });
  } catch {
    // Tracking failure does not affect user operations
  }
}

/** Flush all pending events before process exit (non-blocking) */
export async function shutdownTelemetry(): Promise<void> {
  try {
    if (_client) {
      // Don't wait for flush, destroy client immediately to avoid network timeout blocking process exit
      _client.shutdown().catch(() => {});
      _client = null;
    }
  } catch {
    // ignore
  }
}

// ============================================================
// Utility Functions
// ============================================================

function getCliVersion(): string {
  try {
    const pkgPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../package.json'
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}
