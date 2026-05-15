// Site footer. Rendered globally from app/layout.tsx; appears under every page.
// Plain links — Terms · Privacy · Status · Contact.

export function Footer() {
  return (
    <footer className="border-t border-zinc-800 mt-12">
      <div className="max-w-7xl mx-auto px-4 py-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-zinc-500">
        <span className="text-zinc-600">© {new Date().getFullYear()} Feed Sorter</span>
        <nav className="flex flex-wrap gap-x-5 gap-y-2 ml-auto">
          <a href="/terms" className="hover:text-zinc-200">Terms</a>
          <a href="/privacy" className="hover:text-zinc-200">Privacy</a>
          <a
            href="https://status.feedsorter.app"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:text-zinc-200"
          >
            Status
          </a>
          <a href="mailto:hello@feedsorter.app" className="hover:text-zinc-200">
            Contact
          </a>
        </nav>
      </div>
    </footer>
  );
}
