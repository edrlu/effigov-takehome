import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-24 text-center">
      <p className="font-mono text-[13px] text-faint">404</p>
      <h1 className="text-[18px] font-semibold tracking-tight">That record does not exist</h1>
      <p className="max-w-sm text-[13px] leading-5 text-muted">
        The case or call you are looking for may have been removed, or the link is wrong.
      </p>
      <Link
        href="/"
        className="mt-2 h-8 rounded-md border border-line px-3 text-[13px] leading-8 text-ink transition-colors hover:border-line-strong"
      >
        Back to cases
      </Link>
    </div>
  );
}
