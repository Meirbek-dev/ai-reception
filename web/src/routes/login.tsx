import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import Login03 from "@/components/login-03";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

const REMEMBER_ME_STORAGE_KEY = "ai-reception.rememberMe";

function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { login, isAuthenticated, isLoading: authLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      navigate({ to: "/review" });
    }
  }, [authLoading, isAuthenticated, navigate]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(REMEMBER_ME_STORAGE_KEY);
      if (stored !== null) {
        setRememberMe(stored === "true");
      }
    } catch (error) {
      console.warn("Unable to read remember-me preference", error);
    }
  }, []);

  const handleRememberChange = useCallback((value: boolean) => {
    setRememberMe(value);
    try {
      window.localStorage.setItem(REMEMBER_ME_STORAGE_KEY, String(value));
    } catch (error) {
      console.warn("Unable to persist remember-me preference", error);
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email || !password) {
      toast.error("Пожалуйста, заполните все поля");
      return;
    }

    setIsSubmitting(true);
    try {
      await login(email, password, rememberMe);
      toast.success("Успешный вход");
      navigate({ to: "/review" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ошибка входа";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (authLoading) {
    return (
      <Login03
        email={email}
        password={password}
        rememberMe={rememberMe}
        onEmailChange={(value) => setEmail(value)}
        onPasswordChange={(value) => setPassword(value)}
        onRememberChange={handleRememberChange}
        onSubmit={(event) => event.preventDefault()}
        isSubmitting
        title="AI Reception"
        subtitle="Проверяем сессию..."
        ctaLabel="Войти"
      />
    );
  }

  return (
    <Login03
      email={email}
      password={password}
      rememberMe={rememberMe}
      onEmailChange={(value) => setEmail(value)}
      onPasswordChange={(value) => setPassword(value)}
      onRememberChange={handleRememberChange}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      title="AI Reception"
      subtitle="Войдите, чтобы работать с очередью на проверку"
      ctaLabel="Войти"
    />
  );
}
