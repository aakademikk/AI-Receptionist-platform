import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'Atwood Systems',
  description: 'AI receptionist for missed calls, SMS and WhatsApp.',
  // The dashboard is behind auth and has no business being indexed.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      {/*
        `ambient` carries the backdrop the glass surfaces frost. It lives on <body>
        because that is the only reliably full-bleed element: the login and
        business-picker screens centre themselves in a `max-w-md`/`max-w-2xl` column,
        so a backdrop on their <main> would paint a narrow stripe down the middle
        instead of the page.

        Both of those screens sit outside a tenant shell, so the token resolves to the
        root amber fallback -- which is correct, there is no tenant to tint them. The
        tenant shell carries its own `ambient` over the top of this one, tinted from
        the business's own accent, and covers this the moment it is 100dvh tall.
      */}
      <body className="ambient">{children}</body>
    </html>
  );
}
