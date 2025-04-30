import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// Import the Vercel adapter
import vercel from "@astrojs/vercel";

// https://astro.build/config
export default defineConfig({
  site: "https://www.nudgetheweb.com/",
  vite: {
    plugins: [tailwindcss({ config: "./tailwind.config.mjs" })],
  },
  output: "server",
  adapter: vercel(),
});
