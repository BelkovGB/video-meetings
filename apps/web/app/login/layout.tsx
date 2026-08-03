import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Вход | Video Meetings',
  description: 'Войдите в Video Meetings',
};

export default function LoginLayout({ children }: Readonly<{ children: ReactNode }>) {
  return children;
}
