import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Hash a 6-digit PIN using scrypt with a unique cryptographically random salt.
 * Parameters: N=16384, r=8, p=1, keylen=64 (memory-hard, resistant to brute-force)
 */
export function hashPin(pin: string, existingSalt?: string): { hash: string; salt: string } {
  const salt = existingSalt || crypto.randomBytes(32).toString('hex');
  const derivedKey = crypto.scryptSync(pin, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024
  });
  return {
    hash: derivedKey.toString('hex'),
    salt
  };
}

/**
 * Verify a PIN against the stored scrypt hash in constant time.
 */
export function verifyPin(pin: string, salt: string, expectedHash: string): boolean {
  try {
    const { hash } = hashPin(pin, salt);
    const hashBuf = Buffer.from(hash, 'hex');
    const expectedBuf = Buffer.from(expectedHash, 'hex');
    if (hashBuf.length !== expectedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(hashBuf, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Generate a cryptographically secure random session token and its SHA-256 hash.
 * The raw token is returned to the client once; only the hash is stored in DB.
 */
export function generateSessionToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  return { rawToken, tokenHash };
}

/**
 * Compute SHA-256 hash of a bearer token.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generate standard UUIDv4 identifier.
 */
export function generateId(): string {
  return crypto.randomUUID();
}

const RECOVERY_CHARSET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Generate a cryptographically secure random Recovery Code.
 * Format: HG-XXXX-XXXX-XXXX (12 random chars from 32 unambiguous chars, ~60 bits entropy)
 */
export function generateRecoveryCode(): string {
  const bytes = crypto.randomBytes(12);
  let chars = '';
  for (let i = 0; i < 12; i++) {
    chars += RECOVERY_CHARSET[bytes[i] % RECOVERY_CHARSET.length];
  }
  return `HG-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

/**
 * Normalize a recovery code for consistent comparison.
 * Strips whitespace, dashes, and converts to uppercase.
 */
export function normalizeRecoveryCode(code: string): string {
  return (code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Hash a Recovery Code using scrypt with a unique random 32-byte salt.
 */
export function hashRecoveryCode(code: string, existingSalt?: string): { hash: string; salt: string } {
  const normalized = normalizeRecoveryCode(code);
  const salt = existingSalt || crypto.randomBytes(32).toString('hex');
  const derivedKey = crypto.scryptSync(normalized, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024
  });
  return {
    hash: derivedKey.toString('hex'),
    salt
  };
}

/**
 * Verify a submitted Recovery Code against the stored hash in constant time.
 */
export function verifyRecoveryCode(inputCode: string, salt: string, expectedHash: string): boolean {
  try {
    const { hash } = hashRecoveryCode(inputCode, salt);
    const hashBuf = Buffer.from(hash, 'hex');
    const expectedBuf = Buffer.from(expectedHash, 'hex');
    if (hashBuf.length !== expectedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(hashBuf, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Generate single-use recovery reset authorization token and its SHA-256 hash.
 */
export function generateRecoveryAuthToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  return { rawToken, tokenHash };
}

let cachedEncryptionKey: Buffer | null = null;

/**
 * Retrieve or generate the server-side 256-bit AES encryption key.
 * Stored in env variable RECOVERY_ENCRYPTION_KEY or persisted in data/.recovery_key.
 */
export function getRecoveryEncryptionKey(): Buffer {
  if (cachedEncryptionKey) {
    return cachedEncryptionKey;
  }

  const envKey = process.env.RECOVERY_ENCRYPTION_KEY;
  if (envKey && envKey.trim().length >= 16) {
    cachedEncryptionKey = crypto.createHash('sha256').update(envKey.trim()).digest();
    return cachedEncryptionKey;
  }

  // Persistent key file fallback outside source code
  try {
    const keyPath = path.resolve(process.cwd(), 'data', '.recovery_key');
    if (fs.existsSync(keyPath)) {
      const hex = fs.readFileSync(keyPath, 'utf8').trim();
      if (hex.length === 64) {
        cachedEncryptionKey = Buffer.from(hex, 'hex');
        return cachedEncryptionKey;
      }
    }

    const dir = path.dirname(keyPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const newKey = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, newKey.toString('hex'), { mode: 0o600 });
    cachedEncryptionKey = newKey;
    return cachedEncryptionKey;
  } catch {
    // In-memory fallback if disk is not writable
    cachedEncryptionKey = crypto.randomBytes(32);
    return cachedEncryptionKey;
  }
}

/**
 * Encrypt a temporary Recovery Code using AES-256-GCM.
 */
export function encryptTemporaryCode(code: string, customKey?: Buffer): { encrypted: string; iv: string; tag: string } {
  const key = customKey || getRecoveryEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(code, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    tag
  };
}

/**
 * Decrypt a temporary Recovery Code using AES-256-GCM.
 */
export function decryptTemporaryCode(encrypted: string, ivHex: string, tagHex: string, customKey?: Buffer): string {
  const key = customKey || getRecoveryEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
