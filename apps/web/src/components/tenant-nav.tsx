'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/**
 * Tenant nav. A client island because the active item is derived from the current
 * pathname and, below `md`, because the menu opens and closes.
 *
 * Two different things at two sizes.
 *
 * From `md` up it is what it always was: a right-aligned row of pills with room to
 * spare.
 *
 * Below `md` it is a menu button. The previous version put all seven pills in a
 * horizontal scroller, and that was wrong for the same reason the tables stopped
 * doing it — see the note above `.table-cards` in globals.css: on a real handset
 * there is no visible scrollbar to say more exists, so the sections past the third
 * are not "one swipe away", they are invisible. In practice the header rendered
 * `... Leads  Appointmen` and Analytics, Knowledge and Settings might as well not
 * have been in the product. A half-sliced word is not an affordance.
 *
 * So: one button, every section listed, nothing cut. It also gives the phone its
 * header row back — the shell no longer needs a second row for the nav.
 */
export function TenantNav({ items }: { items: Array<{ href: string; label: string }> }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // A route change closes the menu. Without this, tapping a section leaves the
  // panel sitting open over the page it just navigated to.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    // `pointerdown` rather than `click`: it fires before the browser dispatches a
    // click to whatever is underneath, so tapping the page behind the menu closes
    // it instead of closing it *and* activating a control.
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const activeStyle = {
    color: 'var(--brand)',
    background: 'color-mix(in srgb, var(--brand-accent) 10%, transparent)',
    borderColor: 'var(--edge)',
  };
  const restStyle = { color: 'var(--text-secondary)', borderColor: 'transparent' };

  return (
    <>
      {/* From `md`: the original row, unchanged. */}
      <nav
        className="ml-auto hidden items-center gap-0.5 md:flex"
        aria-label="Sections"
      >
        {items.map((item) => {
          const active = pathname === item.href;
          return (
            <a
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className="shrink-0 rounded-full border px-3 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors hover:brightness-150"
              style={active ? activeStyle : restStyle}
            >
              {item.label}
            </a>
          );
        })}
      </nav>

      {/* Below `md`: a menu button and a panel. */}
      <div ref={wrapRef} className="relative ml-auto md:hidden">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="tenant-nav-menu"
          aria-label={open ? 'Close sections menu' : 'Open sections menu'}
          // 44px square: the minimum a thumb can hit reliably, and the reason this
          // is not sized off the icon.
          className="grid size-11 place-items-center rounded-xl border transition-colors"
          style={{
            borderColor: 'var(--edge)',
            background: open
              ? 'color-mix(in srgb, var(--brand-accent) 12%, transparent)'
              : 'transparent',
            color: open ? 'var(--brand)' : 'var(--text-secondary)',
          }}
        >
          {/* Three lines. `currentColor` so it follows the open/closed colour above. */}
          <svg width="20" height="14" viewBox="0 0 20 14" aria-hidden focusable="false">
            <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="1" y1="1" x2="19" y2="1" />
              <line x1="1" y1="7" x2="19" y2="7" />
              <line x1="1" y1="13" x2="19" y2="13" />
            </g>
          </svg>
        </button>

        {open ? (
          <nav
            id="tenant-nav-menu"
            aria-label="Sections"
            // Anchored to the button's right edge so it opens inward and cannot
            // hang off the screen. `z-50` clears the sticky header's own `z-40`.
            //
            // Opaque, not `.glass`. The header this panel hangs from is itself
            // frosted, and an element with `backdrop-filter` becomes a backdrop root
            // for its descendants — so a panel nested inside it can only ever blur
            // the header's own flat gradient, never the page scrolling underneath.
            // The frost was therefore unrenderable here, and page text showed through
            // the menu crisp. A menu that floats over arbitrary content wants
            // contrast anyway, so it takes a solid surface from the same token set
            // the rest of the app uses. `.hairline` stays for the gradient edge.
            className="hairline absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-2xl p-1.5"
            style={{ background: 'var(--surface-2)' }}
          >
            {items.map((item) => {
              const active = pathname === item.href;
              return (
                <a
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className="block rounded-xl border px-3 py-2.5 text-[15px] font-medium transition-colors"
                  style={active ? activeStyle : restStyle}
                >
                  {item.label}
                </a>
              );
            })}
          </nav>
        ) : null}
      </div>
    </>
  );
}
