import React from 'react';
import './styles.css';

export const metadata = { title: 'SMM Service', description: 'Автопостинг в социальные сети' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="ru"><body>{children}</body></html>;
}
