import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Uses rolldown-vite (the Rust-powered Vite) via the `vite` npm alias in
// package.json. The mirin dev window loads this dev server for HMR.
export default defineConfig({
  root: ".",
  server: { port: 5173, strictPort: true },
  plugins: [react()],
});
