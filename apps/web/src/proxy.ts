import { authkitProxy } from "@workos-inc/authkit-nextjs";
import { appRoutes } from "./routes";

const unauthenticatedPaths = appRoutes
  .filter((route) => !route.isProtected)
  .map((route) => route.path.toString())
  .concat([
    "/",
    "/api/auth/callback",
    "/api/auth/login",
    "/api/trpc/:path*",
    // Explicitly exclude these API endpoints from middleware/auth enforcement:
    "/api/webhooks/:path*",
    // Exclude all CRON JOB Paths
    "/api/v1/crons/:path*",
  ]);

export default authkitProxy({
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths,
  },
  redirectUri: process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ?? undefined,
});

// export const config = {
//   matcher: [
//     // Apply middleware to all frontend routes except Next internals and image assets
//     "/((?!_next/static|_next/image|.*\\.png$).*)",

//     // Apply middleware to all /api routes except these explicitly excluded routes:
//     //  - /api/webhooks/workos/user-created
//     //  - /api/auth/callback
//     //  - /api/auth/login
//     "/api/(?!webhooks/workos/although-duo-gogh/user-created$|auth/callback$|auth/login$).*",
//   ],
// };

export const config = {
  matcher: [
    // Apply middleware to all frontend routes except Next internals and image assets
    "/((?!_next/static|_next/image|.*\\.png$).*)",

    // Match all API routes simply; specific excluded API routes are listed above in unauthenticatedPaths
    "/api/:path*",
  ],
};
