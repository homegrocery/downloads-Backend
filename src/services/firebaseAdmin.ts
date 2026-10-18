import { getApps, initializeApp, cert, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import fs from 'node:fs';

let adminApp: App | null = null;

export function getFirebaseAdminApp(): App {
  if (!adminApp) {
    const existing = getApps();
    if (existing.length > 0) {
      adminApp = existing[0];
    } else {
      const saKeyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

      if (saKeyPath && fs.existsSync(saKeyPath)) {
        try {
          const sa = JSON.parse(fs.readFileSync(saKeyPath, 'utf8'));
          adminApp = initializeApp({
            credential: cert(sa),
            projectId: sa.project_id || 'home-grocery-15eb1'
          });
          console.log('[FirebaseAdmin] Initialized with Service Account credentials');
        } catch (e: any) {
          console.warn('[FirebaseAdmin] Failed to load service account, using project ID fallback:', e.message);
          adminApp = initializeApp({
            projectId: 'home-grocery-15eb1'
          });
        }
      } else {
        adminApp = initializeApp({
          projectId: 'home-grocery-15eb1'
        });
        console.log('[FirebaseAdmin] Initialized with Project ID: home-grocery-15eb1');
      }
    }
  }
  return adminApp;
}

export function getAdminAuth(): Auth {
  const app = getFirebaseAdminApp();
  return getAuth(app);
}

export function getAdminFirestore(): Firestore {
  const app = getFirebaseAdminApp();
  return getFirestore(app);
}
