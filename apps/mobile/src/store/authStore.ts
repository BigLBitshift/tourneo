/**
 * authStore – Central authentication state management.
 * Handles email login, registration, Apple Sign-In, and biometric prompts.
 */
import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import apiClient from '../api/client';
import { useBiometricStore } from './biometricStore';
import { resetAllUserStores } from './storeReset';

export interface User {
  id: number;
  uuid: string;
  email: string;
  first_name: string;
  last_name: string;
  display_name?: string;
  avatar_url?: string;
  role: 'user' | 'admin' | 'superadmin';
  membership_tier: 'free' | 'plus' | 'club';
  auth_provider?: 'email' | 'apple';
  apple_user_id?: string;
}

/**
 * Mirrors `registerSchema` in apps/backend/src/validators/auth.ts.
 * The three consent literals and both version ids are required by the
 * server — omitting any of them fails validation with a 400.
 */
export interface RegisterData {
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  display_name?: string;
  date_of_birth?: string;
  city?: string;
  region?: string;
  country?: string;
  locale?: string;
  consent_terms: true;
  consent_privacy: true;
  consent_age: true;
  consent_media?: boolean;
  terms_version_id: number;
  privacy_version_id: number;
  referral_code?: string;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isInitialized: boolean;
  showBiometricPrompt: boolean;

  initialize: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  loginWithApple: (identityToken: string, fullName?: { firstName?: string; lastName?: string }) => Promise<void>;
  register: (data: RegisterData) => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (data: Partial<User>) => void;
  refreshProfile: () => Promise<void>;
  setShowBiometricPrompt: (show: boolean) => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: false,
  isInitialized: false,
  showBiometricPrompt: false,

  initialize: async () => {
    try {
      const token = await SecureStore.getItemAsync('access_token');
      if (token) {
        const response = await apiClient.get('/auth/me');
        set({
          user: response.data.data,
          isAuthenticated: true,
          isInitialized: true,
        });
      } else {
        set({ isInitialized: true });
      }
    } catch {
      await SecureStore.deleteItemAsync('access_token');
      await SecureStore.deleteItemAsync('refresh_token');
      set({ isInitialized: true });
    }
  },

  login: async (email: string, password: string) => {
    set({ isLoading: true });
    try {
      const response = await apiClient.post('/auth/login', { email, password });
      const { user, access_token, refresh_token } = response.data.data;
      await SecureStore.setItemAsync('access_token', access_token);
      await SecureStore.setItemAsync('refresh_token', refresh_token);
      set({ user, isAuthenticated: true, isLoading: false, showBiometricPrompt: true });
    } catch (error: unknown) {
      set({ isLoading: false });
      const msg = (error as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message || 'Login failed';
      throw new Error(msg);
    }
  },

  loginWithApple: async (identityToken: string, fullName?: { firstName?: string; lastName?: string }) => {
    set({ isLoading: true });
    try {
      const response = await apiClient.post('/auth/apple', {
        identity_token: identityToken,
        first_name: fullName?.firstName,
        last_name: fullName?.lastName,
      });
      const { user, access_token, refresh_token } = response.data.data;
      await SecureStore.setItemAsync('access_token', access_token);
      await SecureStore.setItemAsync('refresh_token', refresh_token);
      set({ user, isAuthenticated: true, isLoading: false, showBiometricPrompt: true });
    } catch (error: unknown) {
      set({ isLoading: false });
      const msg = (error as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message || 'Apple Sign-In failed';
      throw new Error(msg);
    }
  },

  register: async (data: RegisterData) => {
    set({ isLoading: true });
    try {
      const response = await apiClient.post('/auth/register', data);
      const { user, access_token, refresh_token } = response.data.data;
      await SecureStore.setItemAsync('access_token', access_token);
      await SecureStore.setItemAsync('refresh_token', refresh_token);
      set({ user, isAuthenticated: true, isLoading: false, showBiometricPrompt: true });
    } catch (error: unknown) {
      set({ isLoading: false });
      const msg = (error as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message || 'Registration failed';
      throw new Error(msg);
    }
  },

  logout: async () => {
    try {
      await apiClient.post('/auth/logout');
    } catch { /* best effort */ }
    await SecureStore.deleteItemAsync('access_token');
    await SecureStore.deleteItemAsync('refresh_token');
    // Also disable biometrics on logout — best effort.
    try {
      await useBiometricStore.getState().disable();
    } catch (err) {
      if (__DEV__) console.warn('[auth] biometric disable failed:', err);
    }
    // Wipe all per-user caches so the next login does not leak data.
    try {
      await resetAllUserStores();
    } catch (err) {
      if (__DEV__) console.warn('[auth] resetAllUserStores failed:', err);
    }
    set({ user: null, isAuthenticated: false, showBiometricPrompt: false });
  },

  updateUser: (data: Partial<User>) => {
    const current = get().user;
    if (current) {
      set({ user: { ...current, ...data } });
    }
  },

  refreshProfile: async () => {
    try {
      const response = await apiClient.get('/auth/me');
      set({ user: response.data.data });
    } catch { /* silent */ }
  },

  setShowBiometricPrompt: (show: boolean) => set({ showBiometricPrompt: show }),
}));