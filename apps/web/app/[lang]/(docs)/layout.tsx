import { GeistdocsDocsLayout } from '@vercel/geistdocs/layout';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { config } from '@/lib/geistdocs/config';
import { source } from '@/lib/geistdocs/source';

export default async function DocsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (lang !== 'en') notFound();
  return (
    <GeistdocsDocsLayout config={config} tree={source.getPageTree(lang)}>
      {children}
    </GeistdocsDocsLayout>
  );
}

export const generateStaticParams = () => [{ lang: 'en' }];
