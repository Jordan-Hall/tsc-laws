import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-24">
      <h1 className="text-3xl font-semibold">Page not found</h1>
      <p className="mt-4 text-gray-900">This documentation page does not exist.</p>
      <Link className="mt-6 inline-block underline underline-offset-4" href="/">
        TypeScript reference
      </Link>
    </main>
  );
}
