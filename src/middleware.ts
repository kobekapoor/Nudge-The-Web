import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (context, next) => {
  const host = context.request.headers.get("host") || "";
  const hostname = host.split(":")[0];

  if (hostname === "sp.nudgetheweb.com" && !context.url.pathname.startsWith("/sp") && !context.url.pathname.startsWith("/api")) {
    return context.rewrite("/sp");
  }

  return next();
});
