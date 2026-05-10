import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (context, next) => {
  const hostname = context.url.hostname;

  if (hostname === "sp.nudgetheweb.com" && !context.url.pathname.startsWith("/sp") && !context.url.pathname.startsWith("/api")) {
    return context.rewrite("/sp");
  }

  if (hostname === "jw.nudgetheweb.com" && !context.url.pathname.startsWith("/jw") && !context.url.pathname.startsWith("/api")) {
    return context.rewrite("/jw");
  }

  return next();
});
