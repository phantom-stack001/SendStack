import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "CTN | Communication & Technology Network",
    template: "%s | CTN",
  },
  description:
    "CTN helps organizations deliver clear, reliable digital communications with practical tools, careful operations, and accountable support.",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
