import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import react from "@astrojs/react";

// Import the Vercel adapter
import vercel from "@astrojs/vercel";

// https://astro.build/config
export default defineConfig({
  site: "https://www.nudgetheweb.com/",
  vite: {
    plugins: [tailwindcss({ config: "./tailwind.config.mjs" })],
  },
  integrations: [react()],
  output: "server",
  adapter: vercel(),
});
