import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Adjuster — Confidential parametric insurance on Flare",
  description:
    "File a flood claim from a single photograph: verified in a confidential enclave, weather attested by Flare's Data Connector, paid out on-chain in minutes.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
