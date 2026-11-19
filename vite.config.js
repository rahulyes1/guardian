import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        // Libraries change rarely: their own files stay cached across app deploys
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
          if (id.includes("@supabase")) return "supabase";
          return undefined;
        },
      },
    },
  },
});
