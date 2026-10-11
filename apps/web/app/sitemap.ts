import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/geistdocs/config';
import { source } from '@/lib/geistdocs/source';

export default function sitemap(): MetadataRoute.Sitemap {
  if (!siteUrl) return [];
  return source.getPages('en').map((page) => ({ url: new URL(page.url, siteUrl).href }));
}
