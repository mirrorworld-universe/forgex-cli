/**
 * ForgeX CLI Wallet Store
 *
 * Locally encrypted wallet group storage, replacing the frontend IndexedDB persistence.
 * Uses AES encryption for private keys (encryption at rest), supports KDF v3 format import/export.
 *
 * Encryption scheme:
 * - Each WalletInfo.privateKey field is stored encrypted with CryptoJS AES
 * - Master password via FORGEX_PASSWORD env var or inquirer interactive prompt
 * - WalletStoreData.encrypted flag distinguishes encrypted format from legacy plaintext
 * - Legacy format auto-migrates to encrypted format
 */

import fs from 'fs';
import path from 'path';
import CryptoJS from 'crypto-js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { WALLETS_DIR, ensureConfigDir } from './config.js';

// ============================================================
// Type Definitions
// ============================================================

export interface WalletInfo {
  walletAddress: string;
  privateKey: string;   // Stores AES ciphertext in encrypted mode, Base58 private key in plaintext mode
  note: string;
}

export interface GroupInfo {
  name: string;
  groupId: number;
  groupType: 'local' | 'monitor';
  wallets: WalletInfo[];
  monitorType: 'normal' | 'top100' | 'retail';
  note: string;
  monitorCA?: string;
  filterGroupIds?: number[];
}

export interface WalletStoreData {
  groups: Record<number, GroupInfo>;
  notes: Record<string, string>;
  devWallets: Record<string, string>;
  /** Whether storage is encrypted. true means privateKey fields are AES ciphertext */
  encrypted?: boolean;
  /** Checksum for password verification (encrypted known plaintext) */
  passwordCheck?: string;
}

// ============================================================
// Constants
// ============================================================

const STORE_FILE = 'wallet-store.json';
const ENCRYPTED_STORE_FILE = 'wallet-store.enc';

/** Known plaintext marker for password verification */
const PASSWORD_CHECK_PLAINTEXT = 'FORGEX_PASSWORD_OK';

// ============================================================
// Master Password Management
// ============================================================

/** Runtime in-memory master password (valid for process lifetime) */
let _masterPassword: string | null = null;

/**
 * Set master password (called from CLI entry point)
 * Password is saved in memory, only valid for current process lifetime.
 */
export function setMasterPassword(password: string): void {
  _masterPassword = password;
}

/**
 * Get current master password
 * Priority: in-memory password > FORGEX_PASSWORD env var
 */
export function getMasterPassword(): string | null {
  if (_masterPassword) return _masterPassword;
  const envPassword = process.env.FORGEX_PASSWORD;
  if (envPassword) {
    _masterPassword = envPassword;
    return envPassword;
  }
  return null;
}

/**
 * Ensure master password is set.
 * If not set, tries env var; if still not available, prompts via inquirer interactive input.
 * This function is async because it may need to wait for user input.
 */
export async function ensureMasterPassword(): Promise<string> {
  const existing = getMasterPassword();
  if (existing) return existing;

  // Dynamically import inquirer to avoid loading when not needed
  const { password: passwordPrompt } = await import('@inquirer/prompts');
  const pwd = await passwordPrompt({
    message: 'Enter wallet encryption password (master password):',
    mask: '*',
  });

  if (!pwd || pwd.trim().length === 0) {
    throw new Error('Password cannot be empty');
  }

  _masterPassword = pwd;
  return pwd;
}

// ============================================================
// Private Key Encryption/Decryption
// ============================================================

/** Encrypt a private key with master password */
function encryptPrivateKey(plainPrivateKey: string, password: string): string {
  return CryptoJS.AES.encrypt(plainPrivateKey, password).toString();
}

/** Decrypt a private key with master password */
function decryptPrivateKey(encryptedPrivateKey: string, password: string): string {
  const bytes = CryptoJS.AES.decrypt(encryptedPrivateKey, password);
  const result = bytes.toString(CryptoJS.enc.Utf8);
  if (!result) {
    throw new Error('Private key decryption failed: wrong password or corrupted data');
  }
  return result;
}

/**
 * Decrypt a single WalletInfo private key (for SDK and command use)
 *
 * If storage is unencrypted (legacy format), returns original privateKey directly.
 * If encrypted, decrypts with master password and returns Base58 plaintext private key.
 */
export function getDecryptedPrivateKey(walletInfo: WalletInfo): string {
  const password = getMasterPassword();

  // If no password set, assume unencrypted format, return directly
  if (!password) {
    return walletInfo.privateKey;
  }

  // Try to decrypt
  try {
    const decrypted = decryptPrivateKey(walletInfo.privateKey, password);
    // Verify decrypted result is a valid Base58 private key
    bs58.decode(decrypted);
    return decrypted;
  } catch {
    // If decryption fails, may be unencrypted plaintext private key (backward compatible)
    try {
      bs58.decode(walletInfo.privateKey);
      return walletInfo.privateKey;
    } catch {
      throw new Error(
        `Private key decryption failed: wrong password or corrupted key data (wallet: ${walletInfo.walletAddress})`
      );
    }
  }
}

/**
 * Async version of decryption function, auto-ensures password is set
 */
export async function getDecryptedPrivateKeyAsync(walletInfo: WalletInfo): Promise<string> {
  await ensureMasterPassword();
  return getDecryptedPrivateKey(walletInfo);
}

/** Generate password checksum */
function generatePasswordCheck(password: string): string {
  return CryptoJS.AES.encrypt(PASSWORD_CHECK_PLAINTEXT, password).toString();
}

/** Verify if password is correct */
function verifyPassword(password: string, checkValue: string): boolean {
  try {
    const bytes = CryptoJS.AES.decrypt(checkValue, password);
    const result = bytes.toString(CryptoJS.enc.Utf8);
    return result === PASSWORD_CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

// ============================================================
// Utility Functions
// ============================================================

function getStorePath(): string {
  ensureConfigDir();
  return path.join(WALLETS_DIR, STORE_FILE);
}

function getEncryptedStorePath(): string {
  ensureConfigDir();
  return path.join(WALLETS_DIR, ENCRYPTED_STORE_FILE);
}

// ============================================================
// Storage Operations
// ============================================================

/** Load wallet store data (raw format, does not decrypt private keys) */
export function loadWalletStore(): WalletStoreData {
  const storePath = getStorePath();
  if (!fs.existsSync(storePath)) {
    return { groups: {}, notes: {}, devWallets: {} };
  }

  try {
    const raw = fs.readFileSync(storePath, 'utf-8');
    return JSON.parse(raw) as WalletStoreData;
  } catch (err) {
    // File corrupted: backup corrupted file and warn user
    const bakPath = `${storePath}.bak`;
    try {
      fs.renameSync(storePath, bakPath);
      console.warn(
        `Warning: wallet store file is corrupted, backed up to ${bakPath}. Will continue with empty data.`
      );
    } catch {
      console.warn(
        `Warning: wallet store file is corrupted and backup failed. Will continue with empty data.`
      );
    }
    return { groups: {}, notes: {}, devWallets: {} };
  }
}

/** Save wallet store data */
export function saveWalletStore(data: WalletStoreData): void {
  ensureConfigDir();
  const storePath = getStorePath();
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

// ============================================================
// Encryption Migration
// ============================================================

/**
 * Detect if storage is legacy format (unencrypted), prompt and execute migration if so.
 *
 * This function should be called at CLI entry. Migration process:
 * 1. Read plaintext storage
 * 2. Ensure user has set master password
 * 3. Encrypt all privateKey fields
 * 4. Add encrypted flag and password checksum
 * 5. Save encrypted storage
 */
export async function migrateToEncryptedStore(): Promise<void> {
  const store = loadWalletStore();

  // Skip if no data or already encrypted
  if (Object.keys(store.groups).length === 0) return;
  if (store.encrypted === true) return;

  // Check if there are private keys to encrypt
  const hasPrivateKeys = Object.values(store.groups).some(
    g => g.wallets.some(w => w.privateKey && w.privateKey.length > 0)
  );
  if (!hasPrivateKeys) return;

  console.warn('Detected wallet store using legacy format (plaintext private keys), migration to encrypted format required.');

  const password = await ensureMasterPassword();

  // Backup original file
  const storePath = getStorePath();
  const bakPath = `${storePath}.pre-encryption.bak`;
  try {
    fs.copyFileSync(storePath, bakPath);
    fs.chmodSync(bakPath, 0o600);
    console.warn(`Original file backed up to ${bakPath}`);
  } catch {
    console.warn('Warning: unable to create backup file, continuing migration...');
  }

  // Encrypt all private keys
  for (const group of Object.values(store.groups)) {
    for (const wallet of group.wallets) {
      if (wallet.privateKey) {
        wallet.privateKey = encryptPrivateKey(wallet.privateKey, password);
      }
    }
  }

  store.encrypted = true;
  store.passwordCheck = generatePasswordCheck(password);
  saveWalletStore(store);

  console.warn('Wallet store successfully migrated to encrypted format.');
}

/**
 * Verify if current master password matches the stored password checksum.
 * Returns true if storage is unencrypted.
 */
export function validateMasterPassword(): boolean {
  const store = loadWalletStore();
  if (!store.encrypted) return true;
  if (!store.passwordCheck) return true; // Skip when no checksum

  const password = getMasterPassword();
  if (!password) return false;

  return verifyPassword(password, store.passwordCheck);
}

/**
 * Ensure password is set and correct. Called by CLI entry before commands requiring private keys.
 */
export async function ensurePasswordAndValidate(): Promise<void> {
  const store = loadWalletStore();
  if (!store.encrypted) return; // Unencrypted storage does not need password

  const password = await ensureMasterPassword();

  if (store.passwordCheck && !verifyPassword(password, store.passwordCheck)) {
    _masterPassword = null; // Clear incorrect password
    throw new Error('Wrong password: unable to decrypt wallet store. Please check your password.');
  }
}

// ============================================================
// Wallet Group Operations
// ============================================================

/** Get all wallet groups */
export function getAllGroups(): GroupInfo[] {
  const store = loadWalletStore();
  return Object.values(store.groups);
}

/** Get a single wallet group */
export function getGroup(groupId: number): GroupInfo | undefined {
  const store = loadWalletStore();
  return store.groups[groupId];
}

/** Save wallet group (create or update) */
export function saveGroup(group: GroupInfo): void {
  const store = loadWalletStore();
  store.groups[group.groupId] = group;
  saveWalletStore(store);
}

/** Delete wallet group */
export function removeGroup(groupId: number): boolean {
  const store = loadWalletStore();
  if (!store.groups[groupId]) return false;
  delete store.groups[groupId];
  saveWalletStore(store);
  return true;
}

/** Add wallets to group (private keys auto-encrypted based on storage state) */
export function addWalletsToGroup(groupId: number, wallets: WalletInfo[]): boolean {
  const store = loadWalletStore();
  const group = store.groups[groupId];
  if (!group) return false;

  // Deduplication check
  const existingAddresses = new Set(group.wallets.map(w => w.walletAddress));
  const newWallets = wallets.filter(w => !existingAddresses.has(w.walletAddress));

  // If storage is encrypted, encrypt new wallet private keys
  if (store.encrypted) {
    const password = getMasterPassword();
    if (!password) {
      throw new Error('Storage is encrypted but no password set, call ensureMasterPassword() first');
    }
    for (const w of newWallets) {
      w.privateKey = encryptPrivateKey(w.privateKey, password);
    }
  }

  group.wallets.push(...newWallets);
  saveWalletStore(store);
  return true;
}

/** Remove wallet from group */
export function removeWalletsFromGroup(groupId: number, addresses: string[]): boolean {
  const store = loadWalletStore();
  const group = store.groups[groupId];
  if (!group) return false;

  const addrSet = new Set(addresses);
  group.wallets = group.wallets.filter(w => !addrSet.has(w.walletAddress));
  saveWalletStore(store);
  return true;
}

// ============================================================
// Wallet Generation
// ============================================================

/** Generate new wallets (returns plaintext private keys, encryption handled by addWalletsToGroup) */
export function generateWallets(count: number): WalletInfo[] {
  const wallets: WalletInfo[] = [];
  for (let i = 0; i < count; i++) {
    const keypair = Keypair.generate();
    wallets.push({
      walletAddress: keypair.publicKey.toBase58(),
      privateKey: bs58.encode(keypair.secretKey),
      note: '',
    });
  }
  return wallets;
}

/** Restore wallet info from private key */
export function walletFromPrivateKey(privateKey: string, note = ''): WalletInfo {
  const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
  return {
    walletAddress: keypair.publicKey.toBase58(),
    privateKey,
    note,
  };
}

// ============================================================
// Encryption / Export (decrypt on export, encrypt on import)
// ============================================================

/** Encrypted export of wallet store (whole-file encryption, for backup) */
export function encryptWalletStore(password: string): string {
  const store = loadWalletStore();

  // If storage is encrypted, decrypt private keys first then encrypt whole
  if (store.encrypted) {
    const masterPwd = getMasterPassword();
    if (masterPwd) {
      for (const group of Object.values(store.groups)) {
        for (const wallet of group.wallets) {
          if (wallet.privateKey) {
            try {
              wallet.privateKey = decryptPrivateKey(wallet.privateKey, masterPwd);
            } catch {
              // If decryption fails, keep as-is
            }
          }
        }
      }
    }
  }

  // Remove encrypted flag (export is whole-file encryption of plaintext data)
  const exportData = { ...store };
  delete exportData.encrypted;
  delete exportData.passwordCheck;

  const json = JSON.stringify(exportData);
  return CryptoJS.AES.encrypt(json, password).toString();
}

/** Decrypt and import wallet store */
export function decryptWalletStore(encrypted: string, password: string): WalletStoreData | null {
  try {
    const bytes = CryptoJS.AES.decrypt(encrypted, password);
    const decrypted = bytes.toString(CryptoJS.enc.Utf8);
    if (!decrypted) return null;
    return JSON.parse(decrypted) as WalletStoreData;
  } catch {
    return null;
  }
}

/** Export wallet group as CSV (auto-decrypts private keys) */
export function exportGroupToCsv(groupId: number): string | null {
  const group = getGroup(groupId);
  if (!group) return null;

  const store = loadWalletStore();
  const password = getMasterPassword();

  const lines = ['WalletAddress,PrivateKey,Note'];
  for (const w of group.wallets) {
    const note = w.note.replace(/,/g, '\\,').replace(/\n/g, '\\n');
    let pk = w.privateKey;
    // If storage is encrypted, decrypt private keys for export
    if (store.encrypted && password) {
      try {
        pk = decryptPrivateKey(pk, password);
      } catch {
        // Keep as-is on decryption failure
      }
    }
    lines.push(`${w.walletAddress},${pk},${note}`);
  }
  return lines.join('\n');
}

/** Import wallets from CSV */
export function importWalletsFromCsv(csvContent: string): WalletInfo[] {
  const lines = csvContent.trim().split('\n');
  const wallets: WalletInfo[] = [];

  // Skip header
  const startIndex = lines[0]?.toLowerCase().includes('walletaddress') ? 1 : 0;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(',');
    if (parts.length < 2) continue;

    const address = parts[0].trim();
    const privateKey = parts[1].trim();
    const note = (parts[2] || '').trim().replace(/\\,/g, ',').replace(/\\n/g, '\n');

    // Validate private key
    try {
      const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
      const derivedAddress = keypair.publicKey.toBase58();
      if (address && derivedAddress !== address) {
        console.warn(`Warning: address mismatch (line ${i + 1}): ${address} != ${derivedAddress}`);
      }
      wallets.push({
        walletAddress: derivedAddress,
        privateKey,
        note,
      });
    } catch {
      console.warn(`Skipping invalid private key (line ${i + 1})`);
    }
  }

  return wallets;
}

/** Export all wallet groups as JSON (compatible with frontend import format, auto-decrypts private keys) */
export function exportAllGroupsJson(): string {
  const groups = getAllGroups();
  const store = loadWalletStore();
  const password = getMasterPassword();

  // If storage is encrypted, decrypt private keys for export
  if (store.encrypted && password) {
    for (const group of groups) {
      for (const wallet of group.wallets) {
        if (wallet.privateKey) {
          try {
            wallet.privateKey = decryptPrivateKey(wallet.privateKey, password);
          } catch {
            // Keep as-is on decryption failure
          }
        }
      }
    }
  }

  return JSON.stringify(groups, null, 2);
}

/** Export encrypted wallet groups JSON */
export function exportEncryptedGroupsJson(password: string): string {
  const json = exportAllGroupsJson();
  return CryptoJS.AES.encrypt(json, password).toString();
}

/** Import wallet groups JSON */
export function importGroupsFromJson(
  jsonContent: string,
  password?: string
): GroupInfo[] | null {
  let content = jsonContent;

  // Try to decrypt
  if (password) {
    try {
      const bytes = CryptoJS.AES.decrypt(content, password);
      const decrypted = bytes.toString(CryptoJS.enc.Utf8);
      if (!decrypted) return null;
      content = decrypted;
    } catch {
      return null;
    }
  }

  try {
    const groups = JSON.parse(content) as GroupInfo[];
    if (!Array.isArray(groups)) return null;
    return groups;
  } catch {
    return null;
  }
}

// ============================================================
// Note Management
// ============================================================

/** Get wallet note */
export function getNote(address: string): string {
  const store = loadWalletStore();
  return store.notes[address] || '';
}

/** Set wallet note */
export function setNote(address: string, note: string): void {
  const store = loadWalletStore();
  store.notes[address] = note;
  saveWalletStore(store);
}

/** Get all notes */
export function getAllNotes(): Record<string, string> {
  const store = loadWalletStore();
  return store.notes;
}
