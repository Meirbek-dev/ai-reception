import { Outlet, createRootRoute } from "@tanstack/react-router";
import { AuthProvider } from "@/contexts/AuthContext";

export const Route = createRootRoute({
  component: () => {
    return (
      <AuthProvider>
        <Outlet />
      </AuthProvider>
    );
  },
});
