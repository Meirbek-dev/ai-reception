/**
 * Authentication API client
 * Handles communication with backend /auth endpoints
 */

const getBackendOrigin = () =>
  import.meta.env?.DEV ? "http://localhost:5040" : window.location.origin;

export interface User {
  id: number;
  email: string;
  role: "reviewer" | "admin";
  created_at: string;
  updated_at: string;
}

export interface LoginResponse {
  message: string;
  user: User;
}

export interface ApiError {
  detail: string;
}

/**
 * Login with email and password
 * Sets httpOnly session cookie on success
 */
export async function login(email: string, password: string): Promise<User> {
  const response = await fetch(`${getBackendOrigin()}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include", // Important: send/receive cookies
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const error: ApiError = await response.json();
    throw new Error(error.detail || "Ошибка входа");
  }

  const data: LoginResponse = await response.json();
  return data.user;
}

/**
 * Logout current user
 * Clears session cookie
 */
export async function logout(): Promise<void> {
  const response = await fetch(`${getBackendOrigin()}/auth/logout`, {
    method: "POST",
    credentials: "include",
  });

  if (!response.ok) {
    const error: ApiError = await response.json();
    throw new Error(error.detail || "Ошибка выхода");
  }
}

/**
 * Get current authenticated user
 * Returns null if not authenticated
 */
export async function getMe(): Promise<User | null> {
  try {
    const response = await fetch(`${getBackendOrigin()}/auth/me`, {
      method: "GET",
      credentials: "include",
    });

    if (response.status === 401) {
      // Not authenticated
      return null;
    }

    if (!response.ok) {
      const error: ApiError = await response.json();
      throw new Error(error.detail || "Не удалось получить данные пользователя");
    }

    const data: { user: User } = await response.json();
    return data.user;
  } catch (error) {
    console.error("Не удалось получить текущего пользователя:", error);
    return null;
  }
}
