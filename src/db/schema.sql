-- Home Grocery Database Schema (घरगुती किराणा यादी)
-- SQLite with WAL mode, foreign keys, and indexes

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version INTEGER UNIQUE NOT NULL,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    mobile_number TEXT UNIQUE NOT NULL,
    pin_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    full_name TEXT NOT NULL,
    preferred_language TEXT NOT NULL DEFAULT 'mr',
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    lock_reason TEXT,
    lock_type TEXT, -- 'AUTOMATIC', 'ADMINISTRATIVE'
    pin_length INTEGER NOT NULL DEFAULT 6,
    role TEXT NOT NULL DEFAULT 'user',
    last_login_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_mobile ON users(mobile_number);

CREATE TABLE IF NOT EXISTS authentication_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    device_info TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON authentication_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON authentication_sessions(user_id);

CREATE TABLE IF NOT EXISTS shopping_lists (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    month_year TEXT NOT NULL,
    monthly_budget REAL NOT NULL DEFAULT 0.0,
    notes TEXT,
    is_archived INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lists_user_month ON shopping_lists(user_id, month_year);
CREATE INDEX IF NOT EXISTS idx_lists_user ON shopping_lists(user_id);

CREATE TABLE IF NOT EXISTS shopping_items (
    id TEXT PRIMARY KEY,
    list_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    name_mr TEXT,
    quantity REAL NOT NULL DEFAULT 1.0,
    unit TEXT NOT NULL DEFAULT 'kg',
    category TEXT NOT NULL DEFAULT 'Kitchen Essentials',
    unit_price REAL DEFAULT NULL,
    estimated_total REAL DEFAULT NULL,
    is_purchased INTEGER NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (list_id) REFERENCES shopping_lists(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_items_list ON shopping_items(list_id);
CREATE INDEX IF NOT EXISTS idx_items_user ON shopping_items(user_id);

CREATE TABLE IF NOT EXISTS sync_operations (
    operation_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    client_timestamp TEXT,
    server_timestamp TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_user_op ON sync_operations(user_id, operation_id);

CREATE TABLE IF NOT EXISTS recovery_codes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE', 'CONSUMED', 'REPLACED'
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    consumed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_user_status ON recovery_codes(user_id, status);

CREATE TABLE IF NOT EXISTS recovery_authorizations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    recovery_code_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    consumed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (recovery_code_id) REFERENCES recovery_codes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recovery_auth_token ON recovery_authorizations(token_hash);
CREATE INDEX IF NOT EXISTS idx_recovery_auth_user ON recovery_authorizations(user_id);

CREATE TABLE IF NOT EXISTS recovery_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    mobile_number TEXT NOT NULL,
    request_token_hash TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CONSUMED'
    verification_method TEXT,
    verification_notes TEXT,
    approved_code_encrypted TEXT,
    approved_code_iv TEXT,
    approved_code_tag TEXT,
    approved_code_hash TEXT,
    approved_code_salt TEXT,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recovery_req_token ON recovery_requests(request_token_hash);
CREATE INDEX IF NOT EXISTS idx_recovery_req_user ON recovery_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_recovery_req_mobile ON recovery_requests(mobile_number);
CREATE INDEX IF NOT EXISTS idx_recovery_req_status ON recovery_requests(status);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id TEXT PRIMARY KEY,
    admin_user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_account_id TEXT,
    target_mobile_number TEXT,
    details TEXT,
    ip_address TEXT,
    is_archived INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_admin_audit_archived ON admin_audit_logs(is_archived);

CREATE TABLE IF NOT EXISTS login_attempts (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    mobile_number TEXT NOT NULL,
    attempted_at TEXT NOT NULL,
    outcome TEXT NOT NULL, -- 'SUCCESS', 'FAILURE'
    reason TEXT NOT NULL,  -- 'INCORRECT_PIN', 'ACCOUNT_LOCKED', 'INVALID_MOBILE', 'AUTHENTICATION_ERROR', 'SUCCESS', 'ACCOUNT_NOT_FOUND'
    consecutive_failed_attempts INTEGER NOT NULL DEFAULT 0,
    lock_triggered INTEGER NOT NULL DEFAULT 0,
    lock_type TEXT,        -- 'AUTOMATIC', 'ADMINISTRATIVE', NULL
    ip_address TEXT,
    request_id TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_user ON login_attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_login_attempts_mobile ON login_attempts(mobile_number);
CREATE INDEX IF NOT EXISTS idx_login_attempts_time ON login_attempts(attempted_at);

CREATE TABLE IF NOT EXISTS reactivation_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    mobile_number TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'APPROVED', 'REJECTED'
    lock_type TEXT,
    lock_reason TEXT,
    failed_attempts_at_lock INTEGER NOT NULL DEFAULT 5,
    admin_user_id TEXT,
    admin_notes TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reactivation_req_user ON reactivation_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_reactivation_req_status ON reactivation_requests(status);
CREATE INDEX IF NOT EXISTS idx_reactivation_req_mobile ON reactivation_requests(mobile_number);

CREATE TABLE IF NOT EXISTS public_website_content (
    id TEXT PRIMARY KEY,
    content_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    published_at TEXT,
    published_by TEXT
);

CREATE TABLE IF NOT EXISTS public_announcements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    title_mr TEXT NOT NULL,
    content TEXT NOT NULL,
    content_mr TEXT NOT NULL,
    category TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    published_at TEXT,
    expires_at TEXT,
    safe_links_json TEXT,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_public_announcements_status ON public_announcements(status);
CREATE INDEX IF NOT EXISTS idx_public_announcements_pub ON public_announcements(published_at);

CREATE TABLE IF NOT EXISTS release_records (
    id TEXT PRIMARY KEY,
    version_name TEXT NOT NULL,
    build_number INTEGER NOT NULL,
    version_code INTEGER NOT NULL,
    channel TEXT NOT NULL DEFAULT 'STABLE',
    status TEXT NOT NULL DEFAULT 'DRAFT',
    release_notes TEXT NOT NULL,
    release_notes_mr TEXT NOT NULL,
    is_mandatory INTEGER NOT NULL DEFAULT 0,
    min_supported_build INTEGER NOT NULL DEFAULT 1,
    apk_filename TEXT,
    apk_download_url TEXT,
    apk_size_bytes INTEGER,
    sha256_hash TEXT,
    git_commit_hash TEXT,
    git_branch TEXT DEFAULT 'main',
    build_logs TEXT,
    verified_at TEXT,
    published_at TEXT,
    rolled_back_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    initiated_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_release_records_code ON release_records(version_code);
CREATE INDEX IF NOT EXISTS idx_release_records_status ON release_records(status);
