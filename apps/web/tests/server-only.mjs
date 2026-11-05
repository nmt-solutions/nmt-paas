import { registerHooks } from "node:module";

// Next's bundler normally handles this marker. Use its empty server export
// without selecting React's RSC build for the standalone request test runner.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export {};", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
