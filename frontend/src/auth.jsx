import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setUnauthorizedHandler, tokenStore } from './api.js';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

export const homeFor = (role) => ({ admin: '/admin', reseller: '/reseller', customer: '/app' })[role] || '/login';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [brandName, setBrandName] = useState('WA Campaign Panel');
  const [loading, setLoading] = useState(Boolean(tokenStore.get()));
  const [notice, setNotice] = useState('');

  const clearSession = useCallback((message = '') => {
    tokenStore.clear();
    setUser(null);
    setNotice(message);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler((message) => clearSession(message || 'Your session has expired. Please sign in again.'));
  }, [clearSession]);

  useEffect(() => {
    if (!tokenStore.get()) return undefined;
    let alive = true;
    api
      .get('/auth/me')
      .then((r) => {
        if (!alive) return;
        setUser(r.user);
        setBrandName(r.brandName);
      })
      .catch(() => {
        if (alive) clearSession();
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [clearSession]);

  const login = useCallback(async (email, password) => {
    const r = await api.post('/auth/login', { email, password }, { auth: false });
    tokenStore.set(r.token);
    setNotice('');
    setUser(r.user);
    try {
      const me = await api.get('/auth/me');
      setBrandName(me.brandName);
    } catch {
      /* brand name is cosmetic */
    }
    return r.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* the token may already be invalid; sign out locally either way */
    }
    clearSession();
  }, [clearSession]);

  const replaceSession = useCallback((token, nextUser) => {
    tokenStore.set(token);
    setUser(nextUser);
  }, []);

  /** Re-reads the signed-in user (credit balance etc.) without touching the loading state. */
  const refreshUser = useCallback(async () => {
    try {
      const r = await api.get('/auth/me');
      setUser(r.user);
      return r.user;
    } catch {
      return null; // a 401 is already handled by the global unauthorized handler
    }
  }, []);

  const value = useMemo(
    () => ({ user, setUser, brandName, setBrandName, loading, notice, login, logout, replaceSession, refreshUser }),
    [user, brandName, loading, notice, login, logout, replaceSession, refreshUser],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
