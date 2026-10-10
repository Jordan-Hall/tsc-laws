import { Footer } from '@vercel/geistdocs/footer';
import { GeistdocsThemeScript } from '@vercel/geistdocs/layout';
import { Navbar } from '@vercel/geistdocs/navbar';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { GeistPixelSquare } from 'geist/font/pixel';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DocsProvider } from '@/components/provider';
import { config, siteUrl } from '@/lib/geistdocs/config';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: siteUrl ? new URL(siteUrl) : undefined,
  title: { default: 'tsc-ts — TypeScript reference and compiler documentation', template: '%s | tsc-ts' },
  description: 'An unofficial reference to the TypeScript language, with documentation for the tsc-ts compiler.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} ${GeistPixelSquare.variable} antialiased`}
    >
      <head>
        <GeistdocsThemeScript />
      </head>
      <body>
        <DocsProvider>
          <Navbar config={config} />
          {children}
          <Footer />
        </DocsProvider>
      </body>
    </html>
  );
}
