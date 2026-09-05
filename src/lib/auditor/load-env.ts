// Import this first (before any module that reads process.env at load time,
// e.g. "@/db") in standalone auditor check scripts run directly via tsx
// rather than through scripts/*.ts (which already loads env via
// scripts/lib/env.ts). Mirrors that file's logic without depending on it,
// since scripts/** is outside this module's ownership.
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });
