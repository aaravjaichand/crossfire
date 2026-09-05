import { NextResponse } from "next/server";
import { sql as pgsql } from "drizzle-orm";
import { db } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(pgsql`select 1`);
    return NextResponse.json({ ok: true, db: "ok" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, db: message }, { status: 500 });
  }
}
