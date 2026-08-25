import type { Metadata } from 'next';
import { Inter, JetBrains_Mono, Manrope } from 'next/font/google';
import type { ReactNode } from 'react';

import './globals.css';

const manrope = Manrope({
  variable: '--font-manrope',
  subsets: ['latin', 'cyrillic'],
});

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin', 'cyrillic'],
});

const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains-mono',
  subsets: ['latin', 'cyrillic'],
});

export const metadata: Metadata = {
  title: 'Video Meetings',
  description: 'Планируйте и проводите встречи в одном месте',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="ru"
      className={`h-full ${manrope.variable} ${inter.variable} ${jetbrainsMono.variable}`}
    >
      <body className="h-full font-body">{children}</body>
    </html>
  );
}
