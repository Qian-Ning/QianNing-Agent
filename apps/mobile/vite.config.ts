import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Relative asset URLs, because the same bundle is served from three places: the
 * Host at `/app`, a Capacitor WebView on `https://localhost`, and `vite preview`.
 * An absolute `/assets/...` path only works for the first of those.
 */
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
