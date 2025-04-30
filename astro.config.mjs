import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// Import the Vercel adapter
import vercel from "@astrojs/vercel";

// https://astro.build/config
export default defineConfig({
  site: "https://positivustheme.vercel.app",
  vite: {
    plugins: [tailwindcss({ config: "./tailwind.config.mjs" })],
  },
  output: "server",
  adapter: vercel(),
});
