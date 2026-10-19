-- Home Grocery PostgreSQL Schema for Neon
-- Compatible with PostgreSQL 15+

CREATE TABLE IF NOT EXISTS schema_migrations (
    id SERIAL PRIMARY KEY,
    version INTEGER UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    mobile_number VARCHAR(15) UNIQUE NOT NULL,
    pin_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    preferred_language VARCHAR(5) NOT NULL DEFAULT 'mr',
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    pin_length INTEGER NOT NULL DEFAULT 6,
    role VARCHAR(20) NOT NULL DEFAULT 'user',
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_mobile ON users(mobile_number);

CREATE TABLE IF NOT EXISTS authentication_sessions (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(128) UNIQUE NOT NULL,
    device_info TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    last_active_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON authentication_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON authentication_sessions(user_id);

CREATE TABLE IF NOT EXISTS shopping_lists (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    month_year VARCHAR(32) NOT NULL,
    monthly_budget DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    notes TEXT,
    is_archived INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lists_user_month ON shopping_lists(user_id, month_year);
CREATE INDEX IF NOT EXISTS idx_lists_user ON shopping_lists(user_id);

CREATE TABLE IF NOT EXISTS shopping_items (
    id VARCHAR(64) PRIMARY KEY,
    list_id VARCHAR(64) NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    name_mr VARCHAR(255),
    quantity DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    unit VARCHAR(32) NOT NULL DEFAULT 'kg',
    category VARCHAR(64) NOT NULL DEFAULT 'Kitchen Essentials',
    unit_price DOUBLE PRECISION DEFAULT NULL,
    estimated_total DOUBLE PRECISION DEFAULT NULL,
    is_purchased INTEGER NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_list ON shopping_items(list_id);
CREATE INDEX IF NOT EXISTS idx_items_user ON shopping_items(user_id);

CREATE TABLE IF NOT EXISTS sync_operations (
    operation_id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_type VARCHAR(32) NOT NULL,
    entity_id VARCHAR(64) NOT NULL,
    action VARCHAR(32) NOT NULL,
    client_timestamp TIMESTAMPTZ,
    server_timestamp TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_user_op ON sync_operations(user_id, operation_id);

CREATE TABLE IF NOT EXISTS recovery_codes (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash VARCHAR(128) NOT NULL,
    salt VARCHAR(128) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_user_status ON recovery_codes(user_id, status);

CREATE TABLE IF NOT EXISTS recovery_authorizations (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(128) UNIQUE NOT NULL,
    recovery_code_id VARCHAR(64) NOT NULL REFERENCES recovery_codes(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_recovery_auth_token ON recovery_authorizations(token_hash);
CREATE INDEX IF NOT EXISTS idx_recovery_auth_user ON recovery_authorizations(user_id);

CREATE TABLE IF NOT EXISTS recovery_requests (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) REFERENCES users(id) ON DELETE CASCADE,
    mobile_number VARCHAR(15) NOT NULL,
    request_token_hash VARCHAR(128) UNIQUE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    verification_method VARCHAR(64),
    verification_notes TEXT,
    approved_code_encrypted TEXT,
    approved_code_iv VARCHAR(64),
    approved_code_tag VARCHAR(64),
    approved_code_hash VARCHAR(128),
    approved_code_salt VARCHAR(128),
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_recovery_req_token ON recovery_requests(request_token_hash);
CREATE INDEX IF NOT EXISTS idx_recovery_req_user ON recovery_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_recovery_req_mobile ON recovery_requests(mobile_number);
CREATE INDEX IF NOT EXISTS idx_recovery_req_status ON recovery_requests(status);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    admin_user_id VARCHAR(64) NOT NULL,
    action VARCHAR(64) NOT NULL,
    target_account_id VARCHAR(64),
    target_mobile_number VARCHAR(15),
    details TEXT,
    ip_address VARCHAR(64),
    is_archived INTEGER NOT NULL DEFAULT 0,
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_admin_audit_archived ON admin_audit_logs(is_archived);

