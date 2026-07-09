import type { Metadata } from "next";
import { Providers } from "./providers.js";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cadence",
  description: "Merchant dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
