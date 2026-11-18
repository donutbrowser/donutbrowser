import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  clearScreen: false,
  server: {
    // tauri.conf.json `devUrl` points here.
    port: 12341,
    strictPort: true,
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/e2e/**",
        "**/donut-sync/**",
        "**/sdk/**",
      ],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Flags and fonts stay files: inlined into the CSS they would be parsed at
    // startup, used or not.
    assetsInlineLimit: 0,
    rolldownOptions:
      command === "build"
        ? {
            output: {
              minify: {
                compress: { dropConsole: true },
                mangle: true,
                codegen: true,
              },
            },
          }
        : undefined,
  },
}));
