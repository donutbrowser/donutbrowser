import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The app draws 4:3 flags only (`fi fi-xx`). Dropping flag-icons' square
 * `.fis` rules keeps its 1x1 SVGs, half of its size, out of the build.
 */
function flagsWithoutSquareSet(): Plugin {
  return {
    name: "flags-without-square-set",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("/flag-icons/css/")) return;
      const css = code.replace(/\.fi(?:-[a-z0-9-]+)?\.fis\{[^}]*\}/g, "");
      if (css === code) {
        this.warn("flag-icons has no .fis rules; the 1x1 flags may ship");
      }
      return { code: css, map: null };
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [flagsWithoutSquareSet(), react(), tailwindcss()],
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
    // The app ships every chunk on disk; size warnings meant for the web do not apply.
    chunkSizeWarningLimit: 4096,
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
