# Web app

The tsc-ts documentation site lives in this directory.

From the repository root:

```sh
npm ci
npm run dev:web
npm run build:web
npm run type-check -w @tsc-ts/web
npm test -w @tsc-ts/web
npm run check:examples -w @tsc-ts/web
npm run test:routes -w @tsc-ts/web
```

## Deployment

Create a Vercel project with `apps/web` as its root directory, the Next.js framework preset, and access to files outside the root directory. Use the repository's npm workspace lockfile. Set the install command to `npm ci --prefix ../..` and the build command to `npm run build`. No AI or search provider credentials are needed.

Set `NEXT_PUBLIC_SITE_URL` to the site's absolute production URL for canonical URLs and the sitemap. On Vercel, `VERCEL_PROJECT_PRODUCTION_URL` is used when the explicit URL is absent. Preview deployments discourage indexing.

## Content

Keep pages focused on installing and using tsc-ts. Link implementation claims to the repository and describe compatibility only within the scope covered by the comparison suites.

`npm run check:examples -w @tsc-ts/web` checks TypeScript examples with the web app's TypeScript dependency. A passing example check does not establish tsc-ts compatibility.

The content tests check internal links, page metadata, and navigation. After a production build, `test:routes` checks rendered pages, search, Markdown output, and missing-page responses.
