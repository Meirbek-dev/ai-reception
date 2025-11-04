import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import Login03 from "@/components/login-03";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { login, isAuthenticated, isLoading: authLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      navigate({ to: "/review" });
    }
  }, [authLoading, isAuthenticated, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email || !password) {
      toast.error("Пожалуйста, заполните все поля");
      return;
    }

    setIsSubmitting(true);
    try {
      await login(email, password);
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
      <div className="flex min-h-screen items-center justify-center bg-muted/30">
        <Login03
          email={email}
          password={password}
          onEmailChange={(value) => setEmail(value)}
          onPasswordChange={(value) => setPassword(value)}
          onSubmit={(event) => event.preventDefault()}
          isSubmitting
          title="AI Reception"
          subtitle="Проверяем сессию..."
          ctaLabel="Войти"
        />
      </div>
    );
  }

  return (
    <div className="bg-muted/30">
      <Login03
        email={email}
        password={password}
        onEmailChange={(value) => setEmail(value)}
        onPasswordChange={(value) => setPassword(value)}
        onSubmit={handleSubmit}
        isSubmitting={isSubmitting}
        title="AI Reception"
        subtitle="Войдите, чтобы работать с очередью на проверку"
        ctaLabel="Войти"
      />
    </div>
  );
}
