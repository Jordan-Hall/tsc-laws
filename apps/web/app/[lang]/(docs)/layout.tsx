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
  const tree = source.getPageTree(lang);

  function flattenSidebar(items: typeof tree.children): typeof tree.children {
    return items.flatMap((item) => {
      if (item.type !== 'folder') return [item];
      return [...(item.index ? [item.index] : []), ...flattenSidebar(item.children)];
    });
  }

  const sidebarTree = { ...tree, children: flattenSidebar(tree.children) };
  return (
    <GeistdocsDocsLayout config={config} tree={sidebarTree}>
      {children}
    </GeistdocsDocsLayout>
  );
}

export const generateStaticParams = () => [{ lang: 'en' }];
