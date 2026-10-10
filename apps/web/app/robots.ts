import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/geistdocs/config';

export default function robots(): MetadataRoute.Robots {
  const preview = process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production';
  return {
    rules: { userAgent: '*', ...(preview ? { disallow: '/' } : { allow: '/' }) },
    sitemap: siteUrl ? new URL('/sitemap.xml', siteUrl).href : undefined,
  };
}
