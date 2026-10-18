/**
 * Normalize and validate an Indian mobile number.
 * Accepts formats:
 * - "+919876543210"
 * - "919876543210"
 * - "09876543210"
 * - "9876543210"
 * Returns normalized 10-digit string starting with 6, 7, 8, or 9; or null if invalid.
 */
export function normalizeMobileNumber(input: string): string | null {
  if (!input || typeof input !== 'string') return null;
  
  // Remove spaces, hyphens, parentheses, plus signs
  let cleaned = input.replace(/[\s\-\(\)\+]/g, '');

  // Strip international prefix +91 or 91 if length is 12
  if (cleaned.length === 12 && cleaned.startsWith('91')) {
    cleaned = cleaned.substring(2);
  } else if (cleaned.length === 11 && cleaned.startsWith('0')) {
    cleaned = cleaned.substring(1);
  }

  // Must be exactly 10 digits starting with 6, 7, 8, or 9
  if (/^[6-9]\d{9}$/.test(cleaned)) {
    return cleaned;
  }
  return null;
}

/**
 * Validate numeric PIN (4-digit or 6-digit).
 * If expectedLength is provided (4 or 6), validates exactly that length.
 * Otherwise validates that the PIN is either 4 or 6 digits.
 * Preserves string representation so leading zeros are never lost.
 */
export function validatePin(pin: string, expectedLength?: 4 | 6 | number): boolean {
  if (!pin || typeof pin !== 'string') return false;
  if (expectedLength === 4) {
    return /^\d{4}$/.test(pin);
  }
  if (expectedLength === 6) {
    return /^\d{6}$/.test(pin);
  }
  return /^\d{4}$/.test(pin) || /^\d{6}$/.test(pin);
}

/**
 * Validate Month-Year string in "YYYY-MM" format.
 */
export function validateMonthYear(monthYear: string): boolean {
  if (!monthYear || typeof monthYear !== 'string') return false;
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(monthYear);
}
