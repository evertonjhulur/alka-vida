/**
 * Local settings, read from a plain text file next to the launcher.
 *
 * Alka Vida is started by double-clicking an icon, so there is nowhere to set
 * an environment variable. Anything the system needs configuring - today the
 * mail account it sends invoices from - goes in one file the owner edits in
 * Notepad.
 *
 * The file is NEVER created or written by the application, and is gitignored:
 * it holds a password, and that belongs to the person running the business,
 * not to this repository.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root: src/lib -> src -> api -> packages -> root. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SETTINGS_FILE = join(ROOT, 'Alka Vida settings.txt');

/**
 * Load KEY=VALUE lines into the environment.
 *
 * A real environment variable always wins, so a production deployment that
 * sets things properly is never overridden by a file left on disk.
 */
export function loadSettings(): { loaded: boolean; keys: string[] } {
  if (!existsSync(SETTINGS_FILE)) return { loaded: false, keys: [] };

  const keys: string[] = [];
  for (const raw of readFileSync(SETTINGS_FILE, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    // Quotes are what a person naturally types around a value; strip them.
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!value) continue;
    if (process.env[key] === undefined) {
      process.env[key] = value;
      keys.push(key);
    }
  }
  return { loaded: true, keys };
}

export const settingsPath = SETTINGS_FILE;
