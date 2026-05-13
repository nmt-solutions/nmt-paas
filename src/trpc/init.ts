import { initTRPC, TRPCError } from "@trpc/server";
import { withAuth } from "@workos-inc/authkit-nextjs";
import superjson from "superjson";

/**
 * This context creator accepts `headers` so it can be reused in both
 * the RSC server caller (where you pass `next/headers`) and the
 * API route handler (where you pass the request headers).
 */
export const createTRPCContext = async (_opts: { headers: Headers }) => {
  const user = await withAuth();
  return { user };
};

// Avoid exporting the entire t-object
// since it's not very descriptive.
// For instance, the use of a t variable
// is common in i18n libraries.
const t = initTRPC
  .context<Awaited<ReturnType<typeof createTRPCContext>>>()
  .create({
    /**
     * @see https://trpc.io/docs/server/data-transformers
     */
    transformer: superjson,
  });

// Base router and procedure helpers
export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;
export const baseProcedure = t.procedure;

export const authenticatedProcedure = t.procedure.use(async (opts) => {
  const {
    ctx: { user },
  } = opts;

  if (!user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  return opts.next(opts);
});

export const authorizedProdcedure = (permission: string) =>
  authenticatedProcedure.use(async (opts) => {
    const {
      ctx: { user },
    } = opts;

    if (!user) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }

    if (!user.permissions?.includes(permission)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }

    return opts.next(opts);
  });
