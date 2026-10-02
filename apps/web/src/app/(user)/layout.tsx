/**
 * User-facing theme boundary. Themes own their navigation and footer so they
 * can present a coherent site without an additional platform chrome.
 */
export default function UserLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-full flex-1 flex-col">{children}</div>;
}
