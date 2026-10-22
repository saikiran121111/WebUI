import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ruke — Local AI Chat",
  description: "Private, on-device AI chat. Your conversations never leave this machine.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
