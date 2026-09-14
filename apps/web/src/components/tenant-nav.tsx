'use client';

import { usePathname } from 'next/navigation';

/**
 * Tenant nav. A client island only so the active item can be highlighted from the
 * current pathname; everything else in the shell stays on the server.
 */
export function TenantNav({ items }: { items: Array<{ href: string; label: string }> }) {
  const pathname = usePathname();

  return (
    <nav className="ml-auto flex items-center gap-0.5 overflow-x-auto" aria-label="Sections">
      {items.map((item) => {
        const active = pathname === item.href;

        return (
          <a
            key={item.href}
            href={item.href}
            className="whitespace-nowrap rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors hover:brightness-150"
            style={
              active
                ? {
                    color: 'var(--brand)',
                    background: 'color-mix(in srgb, var(--brand-accent) 10%, transparent)',
                    borderColor: 'var(--edge)',
                  }
                : { color: 'var(--text-secondary)', borderColor: 'transparent' }
            }
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
