import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import * as authApi from "@/lib/auth";
import type { SessionInfo, User } from "@/lib/auth";

const REFRESH_MARGIN_MS = 3 * 60 * 1000; // refresh 3 minutes before expiry

interface AuthContextType {
  user: User | null;
  session: SessionInfo | null;
  isLoading: boolean;
  isRefreshing: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string, rememberMe?: boolean) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshTimerRef = useRef<number | null>(null);
  const refreshingRef = useRef(false);
  const lastRefreshAttemptRef = useRef<number>(0);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (refreshingRef.current) {
      return true;
    }
    refreshingRef.current = true;
    setIsRefreshing(true);
    try {
      const refreshed = await authApi.refreshSession();
      if (refreshed) {
        // Only update if the session data has actually changed
        setUser((prev) => {
          if (prev?.id === refreshed.user.id && prev?.email === refreshed.user.email) {
            return prev;
          }
          return refreshed.user;
        });
        setSessionInfo((prev) => {
          if (prev?.expires_at === refreshed.session.expires_at) {
            return prev;
          }
          return refreshed.session;
        });
      } else {
        setUser(null);
        setSessionInfo(null);
      }
      return true;
    } catch (error) {
      console.error("Failed to refresh session:", error);
      setUser(null);
      setSessionInfo(null);
      return false;
    } finally {
      refreshingRef.current = false;
      setIsRefreshing(false);
    }
  }, []);

  // Initialize auth state on mount
  useEffect(() => {
    let cancelled = false;
    const initAuth = async () => {
      try {
        const current = await authApi.getMe();
        if (!cancelled && current) {
          setUser(current.user);
          setSessionInfo(current.session);
        }
      } catch (error) {
        console.error("Не удалось инициализировать аутентификацию:", error);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void initAuth();

    return () => {
      cancelled = true;
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, []); // Only run on mount

  // Schedule automatic refresh when session info changes
  useEffect(() => {
    if (!sessionInfo) {
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      return;
    }

    const expiresAt = Date.parse(sessionInfo.expires_at);
    if (Number.isNaN(expiresAt)) {
      return;
    }

    const now = Date.now();
    const target = Math.max(expiresAt - REFRESH_MARGIN_MS, now + 1000);
    const delay = target - now;

    // Clear any existing timer
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }

    // Prevent rapid re-refresh loops: only schedule if it's been at least 5 seconds since last attempt
    const timeSinceLastRefresh = now - lastRefreshAttemptRef.current;
    if (timeSinceLastRefresh < 5000) {
      // Too soon since last refresh, skip scheduling
      return;
    }

    // Schedule the refresh
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      lastRefreshAttemptRef.current = Date.now();
      void refresh();
    }, Math.max(delay, 100)); // Ensure at least 100ms delay

    return () => {
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionInfo]); // refresh is stable and doesn't need to be a dependency

  const login = useCallback(
    async (email: string, password: string, rememberMe = false) => {
      const authSession = await authApi.login(email, password, rememberMe);
      setUser(authSession.user);
      setSessionInfo(authSession.session);
    },
    [],
  );

  const logout = useCallback(async () => {
    let caughtError: unknown;
    try {
      await authApi.logout();
    } catch (error) {
      caughtError = error;
    } finally {
      setUser(null);
      setSessionInfo(null);
    }

    if (caughtError) {
      if (caughtError instanceof Error) {
        throw caughtError;
      }
      throw new Error("Ошибка выхода");
    }
  }, []);

  const contextValue = useMemo<AuthContextType>(
    () => ({
      user,
      session: sessionInfo,
      isLoading,
      isRefreshing,
      isAuthenticated: user !== null,
      login,
      logout,
      refresh,
    }),
    [isLoading, isRefreshing, login, logout, refresh, sessionInfo, user],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
