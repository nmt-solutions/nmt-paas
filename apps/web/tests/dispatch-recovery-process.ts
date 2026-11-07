// Exercise the same boot hook used by the deployed Next server, in a separate
// process so recovery cannot depend on an admission request's in-memory state.
import { register } from "../src/instrumentation";
await register();
process.send?.("ready");
setInterval(() => {}, 60_000);
