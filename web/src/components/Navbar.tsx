import React from "react";
import { Link } from "@tanstack/react-router";
import { Clock, LogOut, Menu, Moon, RefreshCw, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from "@/components/ui/navigation-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface NavbarProps {
  // Theme
  isDark?: boolean;
  toggleDark?: () => void;

  // Auth
  user: { email: string; role: string } | null;
  isAuthLoading?: boolean;
  onLogout?: () => void;

  // Session refresh (for review page)
  isRefreshing?: boolean;
  onRefreshSession?: () => void;
  sessionExpiresAt?: Date | null;

  // Page context
  currentPage?: "home" | "review";
}

const getInitials = (email?: string) => {
  if (!email) return "?";
  const [local] = email.split("@");
  const parts = local.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const source = parts.length > 0 ? parts : [local];
  const initials = source
    .slice(0, 2)
    .map((segment) => segment[0])
    .join("");
  return initials.toUpperCase().slice(0, 2) || "?";
};

export const Navbar = React.memo(function Navbar({
  isDark = false,
  toggleDark,
  user,
  isAuthLoading = false,
  onLogout,
  isRefreshing = false,
  onRefreshSession,
  sessionExpiresAt = null,
  currentPage = "home",
}: NavbarProps) {
  // Session timer state
  const [timeRemaining, setTimeRemaining] = React.useState<string | null>(null);
  const [sessionWarning, setSessionWarning] = React.useState(false);

  // Update session timer
  React.useEffect(() => {
    if (!sessionExpiresAt) {
      setTimeRemaining(null);
      setSessionWarning(false);
      return;
    }

    const updateTimer = () => {
      const now = new Date();
      const diff = sessionExpiresAt.getTime() - now.getTime();

      if (diff <= 0) {
        setTimeRemaining("Истекла");
        setSessionWarning(true);
        return;
      }

      const minutes = Math.floor(diff / 60_000);
      const seconds = Math.floor((diff % 60_000) / 1000);

      if (minutes < 5) {
        setSessionWarning(true);
      } else {
        setSessionWarning(false);
      }

      if (minutes > 0) {
        setTimeRemaining(`${minutes}м ${seconds}с`);
      } else {
        setTimeRemaining(`${seconds}с`);
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);

    return () => clearInterval(interval);
  }, [sessionExpiresAt]);

  // Build navigation links based on user role
  const navigationLinks = React.useMemo(() => {
    const links = [
      { to: "/", label: "Загрузка документов", active: currentPage === "home" },
    ];

    if (user && (user.role === "reviewer" || user.role === "admin")) {
      links.push({
        to: "/review",
        label: "Очередь на проверку",
        active: currentPage === "review",
      });
    }

    return links;
  }, [user, currentPage]);

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-border bg-card/95 backdrop-blur supports-backdrop-filter:bg-card/80 shadow-sm">
        <div className="mx-auto px-4 sm:px-6 lg:px-8">
          <div className="relative flex h-16 items-center justify-between gap-4">
            {/* Left side - Logo and Navigation */}
            <div className="flex items-center gap-2 lg:gap-4 min-w-0 z-10">
              {/* Mobile menu trigger */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    className="size-9 md:hidden shrink-0"
                    variant="ghost"
                    size="icon"
                    aria-label="Открыть меню навигации"
                  >
                    <Menu className="h-5 w-5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-3 md:hidden">
                  <NavigationMenu
                    className="max-w-none w-full"
                    viewport={false}
                  >
                    <NavigationMenuList className="flex-col items-stretch gap-1 w-full">
                      {navigationLinks.map((link) => (
                        <NavigationMenuItem key={link.to} className="w-full">
                          <NavigationMenuLink asChild active={link.active}>
                            <Link
                              to={link.to}
                              className="flex items-center justify-start w-full h-10 px-3 text-sm font-medium rounded-md transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-active:bg-accent data-active:text-accent-foreground"
                            >
                              {link.label}
                            </Link>
                          </NavigationMenuLink>
                        </NavigationMenuItem>
                      ))}

                      {/* Mobile user info and session timer */}
                      {user && (
                        <div className="w-full mt-2 pt-3 border-t border-border">
                          <div className="px-3 py-2 space-y-1">
                            <div className="text-sm font-medium text-foreground truncate">
                              {user.email}
                            </div>
                            <div className="text-xs uppercase text-muted-foreground">
                              {user.role}
                            </div>
                          </div>
                        </div>
                      )}
                    </NavigationMenuList>
                  </NavigationMenu>
                </PopoverContent>
              </Popover>

              {/* Logo */}
              <Link
                to="/"
                aria-label="Перейти на главную страницу"
                className="block group shrink-0"
              >
                <img
                  src={isDark ? "/logo_light.png" : "/logo_dark.png"}
                  alt="Логотип AI Reception"
                  className="h-12 sm:h-14 w-auto object-contain transition-transform duration-300 group-hover:scale-105"
                />
              </Link>

              {/* Desktop Navigation */}
              <NavigationMenu
                className="hidden md:flex ml-4 lg:ml-6"
                viewport={false}
              >
                <NavigationMenuList className="gap-1">
                  {navigationLinks.map((link) => (
                    <NavigationMenuItem key={link.to}>
                      <NavigationMenuLink asChild active={link.active}>
                        <Link
                          to={link.to}
                          className="group inline-flex h-9 w-max items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-all outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-active:bg-accent data-active:text-accent-foreground"
                        >
                          {link.label}
                        </Link>
                      </NavigationMenuLink>
                    </NavigationMenuItem>
                  ))}
                </NavigationMenuList>
              </NavigationMenu>
            </div>

            {/* Center - Title - Absolutely positioned for perfect centering */}
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none hidden lg:block">
              <h1
                className={`text-2xl font-semibold tracking-tight whitespace-nowrap ${
                  isDark ? "text-foreground" : "text-tou"
                }`}
              >
                AI Reception
              </h1>
            </div>

            {/* Right side - User info and actions */}
            <div className="flex items-center gap-1.5 sm:gap-2 justify-end shrink-0 z-10">
              {isAuthLoading ? (
                <span className="text-sm text-muted-foreground">
                  Проверка...
                </span>
              ) : user ? (
                <>
                  {/* Session Timer Badge - Desktop only */}
                  {timeRemaining && onRefreshSession && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div
                          className={`hidden lg:flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium transition-colors cursor-default ${
                            sessionWarning
                              ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 ring-1 ring-red-200 dark:ring-red-800"
                              : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 ring-1 ring-blue-200 dark:ring-blue-800"
                          }`}
                          role="status"
                          aria-label={`Сессия истекает через ${timeRemaining}`}
                        >
                          <Clock className="h-3.5 w-3.5" />
                          <span>{timeRemaining}</span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Время до истечения сессии</p>
                      </TooltipContent>
                    </Tooltip>
                  )}

                  {/* Action buttons group */}
                  <div className="flex items-center gap-1">
                    {/* Session Refresh Button (review page only) */}
                    {onRefreshSession && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={onRefreshSession}
                            disabled={isRefreshing}
                            className="h-9 w-9 shrink-0"
                            aria-label="Обновить сессию"
                          >
                            <RefreshCw
                              className={`h-4 w-4 ${
                                isRefreshing ? "animate-spin" : ""
                              }`}
                            />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Обновить сессию</p>
                        </TooltipContent>
                      </Tooltip>
                    )}

                    {/* Theme Toggle */}
                    {toggleDark && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={toggleDark}
                            className="h-9 w-9 shrink-0 rounded-full hover:bg-accent transition-colors"
                            aria-label={
                              isDark
                                ? "Переключить на светлую тему"
                                : "Переключить на тёмную тему"
                            }
                          >
                            {isDark ? (
                              <Sun className="h-5 w-5 text-amber-500 transition-transform hover:rotate-90" />
                            ) : (
                              <Moon className="h-5 w-5 transition-transform hover:-rotate-12" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{isDark ? "Светлая тема" : "Тёмная тема"}</p>
                        </TooltipContent>
                      </Tooltip>
                    )}

                    {/* Logout Button */}
                    {onLogout && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={onLogout}
                            className="h-9 w-9 shrink-0 hover:bg-destructive/10 hover:text-destructive"
                            aria-label="Выйти из системы"
                          >
                            <LogOut className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Выйти</p>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>

                  {/* User Avatar and Info - Desktop */}
                  <div className="hidden lg:flex items-center gap-2.5 ml-1 pl-2 border-l border-border">
                    <Avatar className="h-9 w-9 ring-2 ring-border shrink-0">
                      <AvatarFallback className="text-xs font-semibold uppercase bg-primary/10 text-primary">
                        {getInitials(user.email)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="leading-tight min-w-0">
                      <div className="text-sm font-medium text-foreground truncate max-w-[140px]">
                        {user.email}
                      </div>
                      <div className="text-xs uppercase text-muted-foreground tracking-wide">
                        {user.role}
                      </div>
                    </div>
                  </div>

                  {/* User Avatar - Mobile/Tablet */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Avatar className="lg:hidden h-9 w-9 ring-2 ring-border shrink-0 ml-1 cursor-default">
                        <AvatarFallback className="text-xs font-semibold uppercase bg-primary/10 text-primary">
                          {getInitials(user.email)}
                        </AvatarFallback>
                      </Avatar>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="space-y-1">
                        <p className="font-medium">{user.email}</p>
                        <p className="text-xs uppercase text-muted-foreground">
                          {user.role}
                        </p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </>
              ) : (
                <>
                  <Button asChild size="sm" className="text-sm shrink-0">
                    <Link to="/login">Войти как рецензент</Link>
                  </Button>

                  {/* Theme Toggle for non-authenticated users */}
                  {toggleDark && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={toggleDark}
                          className="h-9 w-9 shrink-0 rounded-full hover:bg-accent transition-colors"
                          aria-label={
                            isDark
                              ? "Переключить на светлую тему"
                              : "Переключить на тёмную тему"
                          }
                        >
                          {isDark ? (
                            <Sun className="h-5 w-5 text-amber-500 transition-transform hover:rotate-90" />
                          ) : (
                            <Moon className="h-5 w-5 transition-transform hover:-rotate-12" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{isDark ? "Светлая тема" : "Тёмная тема"}</p>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Refreshing Banner (review page only) */}
      {isRefreshing && (
        <div className="bg-muted/70 border-b border-border animate-in slide-in-from-top-2">
          <div className="mx-auto px-4 sm:px-6 lg:px-8 py-2 flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            <span>Продлеваем вашу сессию...</span>
          </div>
        </div>
      )}
    </>
  );
});
