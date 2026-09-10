import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gif Happens",
  description: "Turn videos into GIFs, fetch clips from YouTube & Instagram.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
