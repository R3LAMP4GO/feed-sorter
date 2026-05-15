import type { Metadata } from 'next';
import { Footer } from '@/components/Footer';
import './globals.css';

export const metadata: Metadata = {
  title: 'Feed Sorter',
  description: 'Sort, transcribe, and dissect short-form videos.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-zinc-950 text-zinc-100 min-h-screen flex flex-col">
        <Nav />
        <main className="max-w-7xl mx-auto w-full px-4 py-6 flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}

function Nav() {
  return (
    <nav className="border-b border-zinc-800 bg-zinc-950/95 backdrop-blur sticky top-0 z-10">
      <div className="max-w-7xl mx-auto px-4 h-12 flex items-center gap-6 text-sm">
        <a href="/library" className="font-semibold tracking-tight">Feed Sorter</a>
        <div className="flex gap-4 text-zinc-400">
          <a href="/library" className="hover:text-zinc-100">Library</a>
          <a href="/hooks" className="hover:text-zinc-100">Hooks</a>
          <a href="/creators" className="hover:text-zinc-100">Creators</a>
          <a href="/billing" className="hover:text-zinc-100 ml-auto">Billing</a>
        </div>
      </div>
    </nav>
  );
}
