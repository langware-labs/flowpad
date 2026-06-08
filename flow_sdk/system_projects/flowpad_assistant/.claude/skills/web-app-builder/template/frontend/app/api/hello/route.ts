import { NextResponse } from "next/server";

// Next.js route handler. Static app/api/* routes take precedence over the
// /api/* rewrite to FastAPI (see next.config.ts).
export async function GET() {
  return NextResponse.json({ message: "Hello from a Next.js route handler" });
}
