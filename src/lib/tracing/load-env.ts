// Import this first in the tracing check, which runs directly via tsx rather
// than through scripts/*.ts. Same reasoning as src/lib/referee/load-env.ts.
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });
