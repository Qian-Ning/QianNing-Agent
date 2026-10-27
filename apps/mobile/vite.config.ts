import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Relative asset URLs, because the same bundle is served from three places: the
 * Host at `/app`, a Capacitor WebView on `https://localhost`, and `vite preview`.
 * An absolute `/assets/...` path only works for the first of those.
 */
const buildStamp = new Date().toISOString().slice(0, 16).replace("T", " ");

export default defineConfig({
  base: "./",
  define: {
    // The only thing that distinguishes two APKs built from the same version
    // number when one of them is broken.
    __BUILD_STAMP__: JSON.stringify(buildStamp),
  },
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
