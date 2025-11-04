"use client";

import type { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface Login03Props {
  email: string;
  password: string;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  isSubmitting?: boolean;
  title?: string;
  subtitle?: string;
  ctaLabel?: string;
}

export default function Login03({
  email,
  password,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  isSubmitting = false,
  title = "Добро пожаловать",
  subtitle = "Введите ваши учетные данные чтобы войти.",
  ctaLabel = "Войти",
}: Login03Props) {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="flex flex-1 flex-col justify-center px-4 py-10 lg:px-6">
        <div className="sm:mx-auto sm:w-full sm:max-w-sm">
          <h3 className="text-center text-lg font-semibold text-foreground">
            {title}
          </h3>
          <p className="text-center text-sm text-muted-foreground">{subtitle}</p>
          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email-login-03" className="text-sm font-medium">
                Email
              </Label>
              <Input
                type="email"
                id="email-login-03"
                value={email}
                autoComplete="email"
                placeholder="admin@example.kz"
                onChange={(event) => onEmailChange(event.target.value)}
                disabled={isSubmitting}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password-login-03" className="text-sm font-medium">
                Пароль
              </Label>
              <Input
                type="password"
                id="password-login-03"
                value={password}
                autoComplete="current-password"
                placeholder="••••••••"
                onChange={(event) => onPasswordChange(event.target.value)}
                disabled={isSubmitting}
                required
              />
            </div>
            <Button type="submit" className="mt-4 w-full py-2 font-medium" disabled={isSubmitting}>
              {isSubmitting ? "Вход..." : ctaLabel}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
