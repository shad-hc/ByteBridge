import type { Metadata } from "next";

import { ThemeProvider } from "@/hooks/useTheme";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ToastProvider } from "@/components/toast-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "ByteBridge",
  description:
    "A direct p2p (peer to peer) file and text sending platform"
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={"antialiased"}>
        <ToastProvider />
        <ThemeProvider>
          <ThemeToggle />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
