import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import api, { tokenStore, ApiError } from './api';
import type { Address, User } from './types';

interface SessionValue {
  user: User | null;
  addresses: Address[];
  loading: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (input: {
    name: string; email: string; phone?: string; password: string;
  }) => Promise<User>;
  logout: () => void;
  refresh: () => Promise<void>;
  saveAddress: (input: Partial<Address> & { line1: string }) => Promise<Address>;
  removeAddress: (id: number) => Promise<void>;
  /** True while we have a token but have not confirmed it yet. */
  ready: boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    if (!tokenStore.get()) {
      setUser(null);
      setAddresses([]);
      setReady(true);
      return;
    }
    try {
      const data = await api.get<{ user: User; addresses: Address[] }>('/api/auth/me');
      setUser(data.user);
      setAddresses(data.addresses);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        tokenStore.clear();
        setUser(null);
      }
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    setLoading(true);
    try {
      const data = await api.post<{ token: string; user: User }>('/api/auth/login', { email, password });
      tokenStore.set(data.token);
      setUser(data.user);
      const me = await api.get<{ addresses: Address[] }>('/api/auth/me');
      setAddresses(me.addresses);
      return data.user;
    } finally {
      setLoading(false);
    }
  }, []);

  const register = useCallback(async (input: {
    name: string; email: string; phone?: string; password: string;
  }) => {
    setLoading(true);
    try {
      const data = await api.post<{ token: string; user: User }>('/api/auth/register', input);
      tokenStore.set(data.token);
      setUser(data.user);
      setAddresses([]);
      return data.user;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    setAddresses([]);
  }, []);

  const saveAddress = useCallback(async (input: Partial<Address> & { line1: string }) => {
    const data = input.id
      ? await api.patch<{ address: Address }>(`/api/auth/me/addresses/${input.id}`, input)
      : await api.post<{ address: Address }>('/api/auth/me/addresses', input);
    await refresh();
    return data.address;
  }, [refresh]);

  const removeAddress = useCallback(async (id: number) => {
    await api.delete(`/api/auth/me/addresses/${id}`);
    await refresh();
  }, [refresh]);

  const value = useMemo<SessionValue>(
    () => ({ user, addresses, loading, login, register, logout, refresh, saveAddress, removeAddress, ready }),
    [user, addresses, loading, login, register, logout, refresh, saveAddress, removeAddress, ready],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside <SessionProvider>');
  return context;
}
