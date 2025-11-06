"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Eye, EyeOff, Loader2, Lock, Mail } from "lucide-react";

export interface Login03Props {
  email: string;
  password: string;
  rememberMe?: boolean;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onRememberChange?: (value: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  isSubmitting?: boolean;
  title?: string;
  subtitle?: string;
  ctaLabel?: string;
}

export default function Login03({
  email,
  password,
  rememberMe = false,
  onEmailChange,
  onPasswordChange,
  onRememberChange,
  onSubmit,
  isSubmitting = false,
  title = "Добро пожаловать",
  subtitle = "Введите ваши учетные данные чтобы войти.",
  ctaLabel = "Войти",
}: Login03Props) {
  const [showPassword, setShowPassword] = useState(false);
  const [emailFocused, setEmailFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);

  return (
    <div className="flex min-h-screen items-center justify-center bg-linear-to-br from-background via-background to-muted/30 p-6">
      <div className="w-full max-w-[420px]">
        <Card className="w-full shadow-2xl border-border/50 backdrop-blur-sm">
          <CardHeader className="space-y-3 text-center pb-8 pt-8">
            <CardTitle className="text-3xl font-bold tracking-tight bg-linear-to-r from-foreground to-foreground/70 bg-clip-text">
              {title}
            </CardTitle>
            <CardDescription className="text-base text-muted-foreground pt-1">
              {subtitle}
            </CardDescription>
          </CardHeader>
          <CardContent className="pb-8 px-8">
            <form onSubmit={onSubmit} className="space-y-6">
              <div className="space-y-2.5">
                <Label
                  htmlFor="email-login-03"
                  className="text-sm font-semibold"
                >
                  Email
                </Label>
                <div className="relative">
                  <Mail
                    className={`absolute left-3.5 top-1/2 -translate-y-1/2 w-[18px] h-[18px] transition-colors ${
                      emailFocused ? "text-primary" : "text-muted-foreground"
                    }`}
                  />
                  <Input
                    type="email"
                    id="email-login-03"
                    value={email}
                    autoComplete="email"
                    placeholder="admin@example.kz"
                    onChange={(event) => onEmailChange(event.target.value)}
                    onFocus={() => setEmailFocused(true)}
                    onBlur={() => setEmailFocused(false)}
                    disabled={isSubmitting}
                    required
                    className={`h-12 pl-11 pr-4 transition-all ${
                      emailFocused
                        ? "ring-2 ring-primary/20 border-primary"
                        : ""
                    }`}
                  />
                </div>
              </div>
              <div className="space-y-2.5">
                <Label
                  htmlFor="password-login-03"
                  className="text-sm font-semibold"
                >
                  Пароль
                </Label>
                <div className="relative">
                  <Lock
                    className={`absolute left-3.5 top-1/2 -translate-y-1/2 w-[18px] h-[18px] transition-colors ${
                      passwordFocused ? "text-primary" : "text-muted-foreground"
                    }`}
                  />
                  <Input
                    type={showPassword ? "text" : "password"}
                    id="password-login-03"
                    value={password}
                    autoComplete="current-password"
                    placeholder="••••••••"
                    onChange={(event) => onPasswordChange(event.target.value)}
                    onFocus={() => setPasswordFocused(true)}
                    onBlur={() => setPasswordFocused(false)}
                    disabled={isSubmitting}
                    required
                    className={`h-12 pl-11 pr-12 transition-all ${
                      passwordFocused
                        ? "ring-2 ring-primary/20 border-primary"
                        : ""
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    disabled={isSubmitting}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed p-1"
                    aria-label={
                      showPassword ? "Скрыть пароль" : "Показать пароль"
                    }
                  >
                    {showPassword ? (
                      <EyeOff className="w-[18px] h-[18px]" />
                    ) : (
                      <Eye className="w-[18px] h-[18px]" />
                    )}
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between text-sm pt-0.5">
                <label className="flex items-center gap-2.5 cursor-pointer group py-1">
                  <Checkbox
                    id="remember-login-03"
                    checked={rememberMe}
                    onCheckedChange={(checked) =>
                      onRememberChange?.(checked === true)
                    }
                    disabled={isSubmitting}
                    aria-label="Запомнить меня"
                    className="transition-all"
                  />
                  <span className="text-muted-foreground select-none group-hover:text-foreground transition-colors">
                    Запомнить меня
                  </span>
                </label>
              </div>
              <Button
                type="submit"
                className="w-full h-12 font-semibold text-base shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 transition-all mt-8"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-[18px] h-[18px] mr-2 animate-spin" />
                    Вход...
                  </>
                ) : (
                  ctaLabel
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
