import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, newNonce } from "@/lib/csp";

/** A fresh CSP nonce for each page; Next.js puts it on its own scripts while rendering. */
export function proxy(request: NextRequest) {
  const policy = contentSecurityPolicy({
    nonce: newNonce(),
    livekitUrl: process.env.LIVEKIT_URL,
    dev: process.env.NODE_ENV === "development",
  });
  const headers = new Headers(request.headers);
  headers.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not the JSON APIs, the MCP endpoint, or build assets.
      source: "/((?!api|mcp|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
