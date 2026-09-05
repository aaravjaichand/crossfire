// Import this first in scripts so DATABASE_URL is set before src/db loads.
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });
