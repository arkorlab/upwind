import type { ReactNode } from 'react';

export const metadata = { title: 'fixture' };

export default function RootLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
