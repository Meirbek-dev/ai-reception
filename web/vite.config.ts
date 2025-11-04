import { URL, fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    viteReact({
      babel: {
        plugins: ['babel-plugin-react-compiler'],
      },
    }),
    tailwindcss(),
  ],
  build: {
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Forward API calls to the backend server running on :5040
      "/upload": "http://localhost:5040",
      "/files": "http://localhost:5040",
      "/download_zip": "http://localhost:5040",
      "/icons": "http://localhost:5040",
      "/health": "http://localhost:5040",
      "/download": "http://localhost:5040",
      "/auth": "http://localhost:5040",
      "/admin": "http://localhost:5040",
    },
  },
});
