import * as SecureStore from 'expo-secure-store';

const API_BASE = 'https://vendora.leaseloft.ai';
const TOKEN_KEY = 'vendora_admin_token';
const ROLE_KEY = 'vendora_user_role';
const USER_KEY = 'vendora_user_info';

let token: string | null = null;
let userRole: 'admin' | 'vendor' | null = null;

export async function loadToken(): Promise<string | null> {
  token = await SecureStore.getItemAsync(TOKEN_KEY);
  userRole = (await SecureStore.getItemAsync(ROLE_KEY)) as 'admin' | 'vendor' | null;
  return token;
}

export async function getRole(): Promise<'admin' | 'vendor' | null> {
  if (userRole) return userRole;
  userRole = (await SecureStore.getItemAsync(ROLE_KEY)) as 'admin' | 'vendor' | null;
  return userRole;
}

export async function saveToken(t: string, role: 'admin' | 'vendor', user: any): Promise<void> {
  token = t;
  userRole = role;
  await SecureStore.setItemAsync(TOKEN_KEY, t);
  await SecureStore.setItemAsync(ROLE_KEY, role);
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
}

export async function getStoredUser(): Promise<any> {
  const raw = await SecureStore.getItemAsync(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}

export async function clearToken(): Promise<void> {
  token = null;
  userRole = null;
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(ROLE_KEY);
  await SecureStore.deleteItemAsync(USER_KEY);
  await SecureStore.deleteItemAsync('vendora_card_scanned');
}

export async function markCardScanned(): Promise<void> {
  await SecureStore.setItemAsync('vendora_card_scanned', '1');
}

export async function isCardScanned(): Promise<boolean> {
  const v = await SecureStore.getItemAsync('vendora_card_scanned');
  return v === '1';
}

export async function apiFetch(path: string, opts: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${API_BASE}${path}`, { ...opts, headers, signal: controller.signal });
  } catch (e: any) {
    if (e.name === 'AbortError') throw new Error('Request timed out — scan can take up to 60 seconds, please try again.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function login(email: string, password: string): Promise<{ success: boolean; role?: 'admin' | 'vendor'; error?: string }> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) return { success: false, error: data.error || 'Login failed' };
  await saveToken(data.token, data.role, data.user);
  return { success: true, role: data.role };
}

export async function logout(): Promise<void> {
  await clearToken();
}
