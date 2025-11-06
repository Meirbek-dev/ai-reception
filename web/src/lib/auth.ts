/**
 * Authentication API client
 * Handles communication with backend /auth endpoints
 */

const JSON_HEADERS = Object.freeze({ "Content-Type": "application/json" });
const NETWORK_ERROR_MESSAGE = "Нет соединения с сервером. Проверьте сеть.";

const getBackendOrigin = () =>
  import.meta.env?.DEV ? "http://localhost:5040" : window.location.origin;

export type UserRole = "reviewer" | "admin";

export interface User {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  last_login_at: string | null;
}

export interface SessionInfo {
  expires_at: string;
  remember_me: boolean;
}

export interface AuthSession {
  user: User;
  session: SessionInfo;
}

export interface LoginResponse extends AuthSession {
  message: string;
}

export interface RefreshResponse extends AuthSession {
  message: string;
}

interface ApiErrorResponse {
  detail?: string;
  message?: string;
  errors?: Array<{ message?: string }>;
}

function extractErrorMessage(payload: ApiErrorResponse | null | undefined) {
  if (!payload) return undefined;
  if (payload.detail) return payload.detail;
  if (payload.message) return payload.message;
  if (payload.errors?.length) {
    const first = payload.errors.find((item) => item?.message);
    if (first?.message) return first.message;
  }
  return undefined;
}

async function readJsonSafe<T>(response: Response): Promise<T | null> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    console.warn("Failed to parse JSON response", error);
    return null;
  }
}

async function buildApiError(
  response: Response,
  fallbackMessage: string,
): Promise<Error> {
  const payload = await readJsonSafe<ApiErrorResponse>(response);
  const message =
    extractErrorMessage(payload) || `${fallbackMessage} (код ${response.status})`;
  return new Error(message);
}

function normalizeUnknownError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(fallbackMessage);
}

function pickAuthSession(data: AuthSession): AuthSession {
  return {
    user: data.user,
    session: data.session,
  };
}

/**
 * Login with email and password
 * Sets httpOnly session cookie on success
 */
export async function login(
  email: string,
  password: string,
  rememberMe = false,
): Promise<AuthSession> {
  try {
    const response = await fetch(`${getBackendOrigin()}/auth/login`, {
      method: "POST",
      headers: JSON_HEADERS,
      credentials: "include",
      body: JSON.stringify({ email, password, remember_me: rememberMe }),
    });

    if (!response.ok) {
      throw await buildApiError(response, "Ошибка входа");
    }

    const data = (await response.json()) as LoginResponse;
    return pickAuthSession(data);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(NETWORK_ERROR_MESSAGE);
    }
    throw normalizeUnknownError(error, "Ошибка входа");
  }
}

/**
 * Logout current user
 * Clears session cookie
 */
export async function logout(): Promise<void> {
  try {
    const response = await fetch(`${getBackendOrigin()}/auth/logout`, {
      method: "POST",
      credentials: "include",
    });

    if (!response.ok) {
      throw await buildApiError(response, "Ошибка выхода");
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(NETWORK_ERROR_MESSAGE);
    }
    throw normalizeUnknownError(error, "Ошибка выхода");
  }
}

/**
 * Get current authenticated user
 * Returns null if not authenticated
 */
export async function getMe(): Promise<AuthSession | null> {
  try {
    const response = await fetch(`${getBackendOrigin()}/auth/me`, {
      method: "GET",
      credentials: "include",
    });

    if (response.status === 401) {
      return null;
    }

    if (!response.ok) {
      throw await buildApiError(
        response,
        "Не удалось получить данные пользователя",
      );
    }

    const data = (await response.json()) as AuthSession;
    return pickAuthSession(data);
  } catch (error) {
    if (error instanceof TypeError) {
      console.error(NETWORK_ERROR_MESSAGE, error);
      return null;
    }
    console.error("Не удалось получить текущего пользователя:", error);
    return null;
  }
}

/**
 * Refresh active session when nearing expiration
 */
export async function refreshSession(): Promise<AuthSession> {
  try {
    const response = await fetch(`${getBackendOrigin()}/auth/refresh`, {
      method: "POST",
      credentials: "include",
    });

    if (response.status === 401) {
      throw new Error("Сессия истекла. Войдите снова.");
    }

    if (!response.ok) {
      throw await buildApiError(response, "Не удалось обновить сессию");
    }

    const data = (await response.json()) as RefreshResponse;
    return pickAuthSession(data);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(NETWORK_ERROR_MESSAGE);
    }
    throw normalizeUnknownError(error, "Не удалось обновить сессию");
  }
}
