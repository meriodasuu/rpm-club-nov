import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
export const metadata: Metadata = {
  title: {
    default: "RPM Club — ваш статус внутри RPM",
    template: "%s · RPM Club",
  },
  description:
    "Закрытый цифровой клуб RPM Rent. Ваши аренды, скидки и привилегии.",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#080808",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body>
        <Script
          src="https://telegram.org/js/telegram-web-app.js"
          strategy="beforeInteractive"
        />
        {children}
      </body>
    </html>
  );
}
