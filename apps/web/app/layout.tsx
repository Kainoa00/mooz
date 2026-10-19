import type { Metadata } from "next";
import { connection } from "next/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "mooz",
  description: "Video meetings where everyone can bring their own AI agent.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Render every page per request, so each gets its own CSP nonce (see proxy.ts).
  await connection();
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
