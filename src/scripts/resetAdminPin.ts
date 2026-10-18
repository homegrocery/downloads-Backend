import readline from 'node:readline';
import { getDatabase } from '../db/database.js';
import { config } from '../config.js';
import { hashPin, generateId } from '../utils/crypto.js';

async function promptForPin(): Promise<string> {
  const argPin = process.argv[2];
  if (argPin) {
    return argPin.trim();
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('Enter new 4 or 6 digit Admin PIN: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const targetMobile = config.adminMobileNumber || '9356755100';
  console.log(`[Admin PIN Reset] Locating owner admin account for mobile: ${targetMobile}`);

  const db = getDatabase();
  const user = db.prepare('SELECT id, mobile_number, full_name, role FROM users WHERE mobile_number = ?').get(targetMobile) as
    | { id: string; mobile_number: string; full_name: string; role: string }
    | undefined;

  if (!user) {
    console.error(`[Error] Owner admin account with mobile ${targetMobile} not found in database.`);
    process.exit(1);
  }

  const newPin = await promptForPin();

  if (!/^\d{4}$|^\d{6}$/.test(newPin)) {
    console.error('[Error] Invalid PIN format. PIN must be exactly 4 or 6 numeric digits.');
    process.exit(1);
  }

  const pinLength = newPin.length;
  const { hash, salt } = hashPin(newPin);
  const nowIso = new Date().toISOString();

  // Update user PIN and reset lockout counters
  db.prepare(`
    UPDATE users
    SET pin_hash = ?,
        salt = ?,
        pin_length = ?,
        failed_login_attempts = 0,
        locked_until = NULL,
        role = 'admin',
        updated_at = ?
    WHERE id = ?
  `).run(hash, salt, pinLength, nowIso, user.id);

  // Revoke any existing active sessions
  const sessionResult = db.prepare('DELETE FROM authentication_sessions WHERE user_id = ?').run(user.id);

  // Record audit log entry
  try {
    const auditId = generateId();
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_user_id, action, target_account_id, target_mobile_number, details, ip_address, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      auditId,
      user.id,
      'ADMIN_PIN_RESET_LOCAL',
      user.id,
      user.mobile_number,
      JSON.stringify({ method: 'local_cli_script', pinLength, sessionsRevoked: sessionResult.changes }),
      '127.0.0.1',
      nowIso
    );
  } catch (err: any) {
    console.warn('[Warning] Could not record audit log:', err.message);
  }

  console.log(`[Success] Owner Admin PIN successfully updated and account unlocked.`);
  console.log(`Account ID: ${user.id}`);
  console.log(`Mobile: ${user.mobile_number}`);
  console.log(`Full Name: ${user.full_name}`);
  console.log(`Role: admin`);
  console.log(`Lockout: CLEARED (failed_login_attempts: 0, locked_until: NULL)`);
  console.log(`Active sessions revoked: ${sessionResult.changes}`);
}

main().catch((err) => {
  console.error('[Fatal Error]:', err);
  process.exit(1);
});
