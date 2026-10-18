# Home Grocery Backend API (घरगुती किराणा यादी)

Production backend API and authoritative SQLite database engine for Home Grocery (घरगुती किराणा यादी).

## System Architecture

- **Runtime:** Node.js 20+ with TypeScript / Express 4.x
- **Authoritative Database:** SQLite (WAL mode, foreign keys, prepared statements via `better-sqlite3`)
- **Authentication:**
  - Owner Admin: 6-digit PIN with scrypt ($N=16384, r=8, p=1$) and unique 32-byte cryptographically random salt.
  - Users: 4- or 6-digit PIN with scrypt hashing.
  - Recovery: 16-character Personal Recovery Codes (`HG-XXXX-XXXX-XXXX`) securely hashed with SHA-256.
- **Role Isolation:**
  - Ordinary users have access strictly to their own grocery lists, budget items, and recovery workflows.
  - Admin ERP endpoints (`/api/admin/*`) require server-side owner-admin token verification (`role === 'admin'`).
  - No grocery list items or user contents are ever exposed via Admin ERP routes.

## API Endpoints

### Health & Diagnostic
- `GET /api/health` — Returns server status, timestamp, uptime, and database connectivity.
- `GET /api/updates/check?clientVersion=1.0.0&clientBuild=5` — Authoritative version manifest check.

### Authentication & Account
- `POST /api/auth/register` — Register a new mobile account with Personal Recovery Code generation.
- `POST /api/auth/login` — Authenticate user and issue JWT bearer token.
- `GET /api/auth/me` — Verify current session.
- `POST /api/auth/logout` — Revoke active session token.
- `POST /api/auth/verify-recovery-code` — Verify 16-character personal recovery code for PIN reset.
- `POST /api/auth/reset-pin-recovery-code` — Complete PIN reset using single-use recovery authorization.

### Grocery Lists & Items
- `GET /api/lists` — Retrieve user's monthly grocery lists.
- `POST /api/lists` — Create a new monthly list (e.g. October 2026 with budget).
- `GET /api/lists/:id` — Get list with item totals.
- `POST /api/lists/:id/items` — Add grocery item with unit, quantity, and price.
- `PUT /api/items/:id` — Update grocery item details and purchased status.
- `DELETE /api/items/:id` — Delete grocery item.

### Owner-Admin ERP (Protected: `role === 'admin'`)
- `POST /api/admin/auth/login` — Owner login (Mobile: `9356755100`).
- `GET /api/admin/auth/me` — Verify owner admin session.
- `PATCH /api/admin/profile` — Update admin display name and preferred language.
- `POST /api/admin/auth/change-pin` — Change admin PIN with old PIN verification.
- `GET /api/admin/accounts` — Metadata-only account directory (excludes PINs and grocery data).
- `POST /api/admin/accounts/:id/delete` — Permanent user account deletion with foreign key cleanup.
- `GET /api/admin/recovery-requests` — Manage pending emergency recovery requests.
- `POST /api/admin/recovery-requests/:id/approve` — Approve request with temporary verification code.
- `GET /api/admin/audit-logs` — Immutable audit trail for administrative actions.

## Local Development

```bash
# Install dependencies
npm install

# Start development server with live reload on port 3001
npm run dev

# Run automated test suite (53 tests)
npm test

# Build for production
npm run build

# Start production server
npm start
```

## Production Deployment (e.g. Render / Cloud VPS)

### Environment Variables
Configure the following in your production environment settings:
```ini
PORT=3001
HOST=0.0.0.0
NODE_ENV=production
DB_PATH=/var/data/homegrocery.db
BACKUP_DIR=/var/data/backups
SESSION_TTL_HOURS=720
MAX_FAILED_ATTEMPTS=5
LOCKOUT_MINUTES=15
```

### Persistent Disk Requirement
> [!IMPORTANT]
> The SQLite database requires a persistent storage mount (e.g. Render Persistent Disk mounted at `/var/data`) so that user accounts and grocery lists survive service redeployments and restarts.
