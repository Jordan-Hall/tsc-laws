# Documentation

The TypeScript reference and tsc-ts documentation use the Vercel Labs [Geistdocs](https://www.npmjs.com/package/@vercel/geistdocs) template.

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

## Writing

Write language rules before examples, state relevant compiler options, and link to upstream sources. Separate JavaScript runtime behavior from TypeScript checking. Explain accepted and rejected cases. Do not infer compiler compatibility from an example or describe corpus results as proof of correctness.

Each TypeScript code block is checked independently with TypeScript 5.9, `strict: true`, ES2022, and bundler module resolution. Use `// @ts-expect-error` for rejected cases; unused directives fail the check. Use `// @filename: file.ts` to split multi-file examples and `// @option: exactOptionalPropertyTypes=true` to change an example's options. These checks validate the examples, not TypeScript 7 or tsc-ts conformance. JavaScript and shell examples are explanatory and are not run by this check.

The content tests check internal links and navigation. After a production build, `test:routes` starts a temporary server and checks HTML, Markdown, content negotiation, search, and missing-page responses. Keep the unofficial status, version scope, and compiler limitations visible when adding pages.
