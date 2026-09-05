import { NextResponse } from "next/server";
import { sql as pgsql } from "drizzle-orm";
import { db } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(pgsql`select 1`);
    return NextResponse.json({ ok: true, db: "ok" });
  } catch (err) {
    // Log the detail server-side; never echo driver errors (they can include
    // host names or connection string fragments) to the client.
    console.error("health check: database query failed", err);
    return NextResponse.json({ ok: false, db: "error" }, { status: 500 });
  }
}
