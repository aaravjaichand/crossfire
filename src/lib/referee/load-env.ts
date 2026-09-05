// Import this first (before any module that reads process.env at load time,
// e.g. "@/db") in the referee check scripts, which run directly via tsx rather
// than through scripts/*.ts. Same reasoning as src/lib/auditor/load-env.ts.
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });
