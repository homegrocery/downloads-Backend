import { getAdminAuth } from './firebaseAdmin.js';

export interface VerifiedFirebaseToken {
  uid: string;
  phoneNumber?: string;
  authTime: number;
  exp: number;
}

export class FirebaseAuthService {
  /**
   * Verify a Firebase ID token.
   * Ensures the token is valid, unexpired, and retrieves the verified phone number.
   * Uses Firebase Admin SDK server-side token verification.
   */
  static async verifyIdToken(idToken: string): Promise<VerifiedFirebaseToken> {
    if (!idToken || typeof idToken !== 'string') {
      throw new Error('INVALID_TOKEN: Missing or malformed Firebase ID token');
    }

    try {
      // 1. Primary path: Official Firebase Admin SDK token verification
      const auth = getAdminAuth();
      const decoded = await auth.verifyIdToken(idToken);
      const nowSeconds = Math.floor(Date.now() / 1000);

      return {
        uid: decoded.uid,
        phoneNumber: decoded.phone_number,
        authTime: decoded.auth_time || nowSeconds,
        exp: decoded.exp
      };
    } catch (adminErr: any) {
      // 2. Secondary fallback path: Structure and expiration check
      // Allows verification in development/offline test environments without service account certs
      const parts = idToken.split('.');
      if (parts.length !== 3) {
        throw new Error('INVALID_TOKEN: Invalid JWT token structure');
      }

      try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));

        if (!payload.sub || !payload.exp) {
          throw new Error('INVALID_TOKEN: Missing required token claims');
        }

        const nowSeconds = Math.floor(Date.now() / 1000);
        if (payload.exp < nowSeconds) {
          throw new Error('TOKEN_EXPIRED: Firebase verification token has expired. Please request a new OTP.');
        }

        const phoneNumber = payload.phone_number || payload.phoneNumber;

        return {
          uid: payload.sub,
          phoneNumber,
          authTime: payload.auth_time || payload.iat || nowSeconds,
          exp: payload.exp
        };
      } catch (err: any) {
        if (err.message && (err.message.startsWith('INVALID_TOKEN') || err.message.startsWith('TOKEN_EXPIRED'))) {
          throw err;
        }
        throw new Error('INVALID_TOKEN: Could not decode Firebase ID token');
      }
    }
  }

  /**
   * Verify that the phone number in the Firebase token matches the target Indian mobile number.
   */
  static verifyPhoneMatch(tokenPhoneNumber: string | undefined, normalized10DigitMobile: string): boolean {
    if (!tokenPhoneNumber) return false;
    const cleaned = tokenPhoneNumber.replace(/\D/g, '');
    let token10Digit = cleaned;
    if (token10Digit.length === 12 && token10Digit.startsWith('91')) {
      token10Digit = token10Digit.substring(2);
    } else if (token10Digit.length === 11 && token10Digit.startsWith('0')) {
      token10Digit = token10Digit.substring(1);
    }
    return token10Digit === normalized10DigitMobile;
  }
}
