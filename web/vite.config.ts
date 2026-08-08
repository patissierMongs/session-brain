import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
  build: { target: "es2022", cssMinify: true },
  server: {
    proxy: { "/api": "http://localhost:7777" },
  },
});
