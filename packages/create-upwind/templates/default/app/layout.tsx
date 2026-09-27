import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'upwind app',
  description: 'A Next.js application, run by upwind.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
