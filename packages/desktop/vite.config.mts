import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Renderer build. base: "./" so the built index.html loads assets via relative paths when
// opened from dist/index.html by Electron's loadFile() (no dev server, no network involved).
export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
