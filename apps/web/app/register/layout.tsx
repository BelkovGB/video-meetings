import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Регистрация | Video Meetings',
  description: 'Создайте аккаунт в Video Meetings',
};

export default function RegisterLayout({ children }: Readonly<{ children: ReactNode }>) {
  return children;
}
