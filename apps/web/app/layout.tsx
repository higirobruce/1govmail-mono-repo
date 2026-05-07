import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "sonner";
import { QueryProvider } from "@/components/providers/QueryProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { ElectronTitleBarLoader } from "@/components/layout/ElectronTitleBarLoader";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import "./globals.css";

// Inter with `latin-ext` so Kinyarwanda and French diacritics render correctly
// (e.g. "Nyarugenge", "Rwandais"). `variable` exposes the font as
// `--font-inter`, consumed by Tailwind via globals.css.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin", "latin-ext"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin", "latin-ext"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "1Gov Mail",
  description: "Government of Rwanda — secure email, calendar, and documents",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} antialiased`}
      >
        <ElectronTitleBarLoader />
        <ServiceWorkerRegister />
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
