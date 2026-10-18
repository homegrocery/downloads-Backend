export interface User {
  id: string;
  mobile_number: string;
  pin_hash: string;
  salt: string;
  full_name: string;
  preferred_language: 'en' | 'mr';
  failed_login_attempts: number;
  locked_until: string | null;
  pin_length: number;
  role: 'user' | 'admin';
  created_at: string;
  updated_at: string;
}

export type SafeUser = Omit<User, 'pin_hash' | 'salt'>;

export interface AuthenticationSession {
  id: string;
  user_id: string;
  token_hash: string;
  device_info: string | null;
  expires_at: string;
  created_at: string;
  last_active_at: string;
}

export interface ShoppingList {
  id: string;
  user_id: string;
  title: string;
  month_year: string;
  monthly_budget: number;
  notes: string | null;
  is_archived: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ShoppingItem {
  id: string;
  list_id: string;
  user_id: string;
  name: string;
  name_mr: string | null;
  quantity: number;
  unit: string;
  category: string;
  unit_price: number;
  estimated_total: number;
  is_purchased: number;
  display_order: number;
  notes: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface SyncOperation {
  operation_id: string;
  user_id: string;
  entity_type: 'list' | 'item';
  entity_id: string;
  action: 'create' | 'update' | 'delete';
  client_timestamp?: string;
  server_timestamp: string;
}

export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  messageMr?: string;
  data?: T;
  error?: string;
}

export interface RecoveryCodeRecord {
  id: string;
  user_id: string;
  code_hash: string;
  salt: string;
  status: 'ACTIVE' | 'CONSUMED' | 'REPLACED';
  failed_attempts: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
  consumed_at: string | null;
}

export interface RecoveryAuthorizationRecord {
  id: string;
  user_id: string;
  token_hash: string;
  recovery_code_id: string;
  expires_at: string;
  created_at: string;
  consumed_at: string | null;
}

export type RecoveryRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CONSUMED';

export interface RecoveryRequestRecord {
  id: string;
  user_id: string | null;
  mobile_number: string;
  request_token_hash: string;
  status: RecoveryRequestStatus;
  verification_method: string | null;
  verification_notes: string | null;
  approved_code_encrypted: string | null;
  approved_code_iv: string | null;
  approved_code_tag: string | null;
  approved_code_hash: string | null;
  approved_code_salt: string | null;
  failed_attempts: number;
  locked_until: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface AdminAuditLogRecord {
  id: string;
  admin_user_id: string;
  action: string;
  target_account_id: string | null;
  target_mobile_number: string | null;
  details: string | null;
  ip_address: string | null;
  created_at: string;
}
