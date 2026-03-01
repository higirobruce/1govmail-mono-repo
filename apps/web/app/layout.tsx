import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "sonner";
import { QueryProvider } from "@/components/providers/QueryProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
// ElectronTitleBarLoader is a Client Component that wraps ElectronTitleBar with
// next/dynamic ssr:false — keeping it 100 % browser-only so it never runs
// during Next.js prerendering (including the /_global-error static page).
import { ElectronTitleBarLoader } from "@/components/layout/ElectronTitleBarLoader";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "1Gov Mail",
  description: "A modern Zimbra email client",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/* Renders a drag-region title bar only in the Electron desktop app on macOS */}
        <ElectronTitleBarLoader />
        <QueryProvider>
        <ThemeProvider>
        <TooltipProvider delayDuration={300}>
          {children}
          <Toaster
            position="bottom-right"
            toastOptions={{
              classNames: {
                toast: 'bg-card border border-border text-foreground text-sm',
                description: 'text-muted-foreground text-xs',
                actionButton: 'bg-primary text-primary-foreground text-xs',
                cancelButton: 'bg-muted text-muted-foreground text-xs',
                error: 'border-destructive/40 bg-destructive/10 text-destructive',
                success: 'border-primary/30',
              },
            }}
          />
        </TooltipProvider>
        </ThemeProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
