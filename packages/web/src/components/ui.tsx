import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';
import type { SessionStatus } from '../store/sessions';
import { platform } from '../platform';
import { placePopover } from '../lib/popover';

export function StatusDot({ status, size = 8 }: { status: SessionStatus; size?: number }) {
  const label = { running: 'Running', 'needs-input': 'Needs your input', error: 'Error', done: 'Finished (unread)', idle: 'Idle', starting: 'Starting' }[status];
  return <span className={`dot dot-${status}`} style={{ width: size, height: size }} role="img" aria-label={label} title={label} />;
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} role="img" aria-label="Working" />;
}

/** Three animated violet dots: "the agent is doing something" (violet is reserved for agent surfaces). */
export function Dots() {
  return <span className="dots" role="img" aria-label="Working"><i /><i /><i /></span>;
}

export function Kbd({ children }: { children: ReactNode }) { return <kbd className="kbd">{children}</kbd>; }

export function IconButton({ icon, label, onClick, active, disabled, size = 15, className = '' }: {
  icon: IconName; label: string; onClick?: (e: React.MouseEvent) => void; active?: boolean; disabled?: boolean; size?: number; className?: string;
}) {
  return (
    <button type="button" className={`icon-btn${active ? ' active' : ''} ${className}`} onClick={onClick} disabled={disabled} aria-label={label} title={label}>
      <Icon name={icon} size={size} />
    </button>
  );
}

export function CopyButton({ text, label = 'Copy', className = '' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button" className={`icon-btn ${className}`} aria-label={label} title={done ? 'Copied' : label}
      onClick={async (e) => {
        e.stopPropagation();
        await platform.copyText(text);
        setDone(true); setTimeout(() => setDone(false), 1400);
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={14} />
    </button>
  );
}

export function useOutsideClose(ref: React.RefObject<HTMLElement>, onClose: () => void, active: boolean, ignore?: React.RefObject<HTMLElement>) {
  useEffect(() => {
    if (!active) return;
    // The trigger is "outside" the popover, but a click on it must toggle (not close and immediately reopen).
    const down = (e: MouseEvent) => { const t = e.target as Node; if (ref.current && !ref.current.contains(t) && !ignore?.current?.contains(t)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [ref, ignore, onClose, active]);
}

export interface MenuItem {
  id: string; label: string; icon?: IconName; hint?: string; description?: string; danger?: boolean; checked?: boolean; disabled?: boolean;
  onSelect: () => void;
}
export type MenuEntry = MenuItem | 'sep' | { heading: string };

export function MenuList({ items, onClose }: { items: MenuEntry[]; onClose: () => void }) {
  const [idx, setIdx] = useState(-1);
  const real = items.filter((i): i is MenuItem => typeof i !== 'string' && 'id' in i);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div
      ref={ref} className="menu" role="menu" tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => (i + 1) % real.length); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => (i <= 0 ? real.length - 1 : i - 1)); }
        else if (e.key === 'Enter' && idx >= 0) { e.preventDefault(); const it = real[idx]; if (!it.disabled) { onClose(); it.onSelect(); } }
      }}
    >
      {items.map((it, k) => {
        if (it === 'sep') return <div key={'s' + k} className="menu-sep" />;
        if ('heading' in it) return <div key={'h' + k} className="menu-heading">{it.heading}</div>;
        const active = real[idx]?.id === it.id;
        return (
          <button
            key={it.id} type="button" role="menuitem" disabled={it.disabled}
            className={`menu-item${it.danger ? ' danger' : ''}${active ? ' focus' : ''}`}
            onMouseEnter={() => setIdx(real.indexOf(it))}
            onClick={() => { onClose(); it.onSelect(); }}
          >
            {it.icon && <Icon name={it.icon} size={15} />}
            <span className="menu-label">
              {it.label}
              {it.description && <span className="menu-desc">{it.description}</span>}
            </span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
            {it.checked && <Icon name="check" size={14} className="menu-check" />}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Anchored popover rendered in a portal. It first renders hidden at the viewport origin with `width: max-content`
 * (transparent, still focusable) so it can be measured at its real size, then (still before paint) is placed next to its trigger. It follows
 * resizes and content changes, and the trigger itself does not count as an outside click.
 */
export function Popover({ anchor, open, onClose, children, align = 'start', width, className = '' }: {
  anchor: React.RefObject<HTMLElement>; open: boolean; onClose: () => void; children: ReactNode; align?: 'start' | 'end'; width?: number; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useOutsideClose(ref, onClose, open, anchor);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const a = anchor.current, el = ref.current;
      if (!a || !el) return;
      const { left, top } = placePopover(a.getBoundingClientRect(), { w: el.offsetWidth, h: el.offsetHeight }, { w: document.documentElement.clientWidth, h: window.innerHeight }, align);
      setPos((p) => (p && Math.abs(p.left - left) < 0.5 && Math.abs(p.top - top) < 0.5 ? p : { left, top }));
    };
    place();
    window.addEventListener('resize', place);
    const ro = typeof ResizeObserver !== 'undefined' && ref.current ? new ResizeObserver(place) : null;
    if (ro && ref.current) ro.observe(ref.current);
    return () => { window.removeEventListener('resize', place); ro?.disconnect(); };
  }, [open, anchor, align, width]);
  if (!open) return null;
  const style: CSSProperties = { position: 'fixed', left: pos?.left ?? 0, top: pos?.top ?? 0, width: 'max-content', maxWidth: 'calc(100vw - 16px)', minWidth: width, ...(pos ? {} : { opacity: 0 }) };
  return createPortal(<div ref={ref} className={`popover ${className}`} style={style}>{children}</div>, document.body);
}

export function Dropdown({ trigger, items, align = 'start', disabled, title }: {
  trigger: (open: boolean) => ReactNode; items: MenuEntry[]; align?: 'start' | 'end'; disabled?: boolean; title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); ref.current?.focus(); };
  return (
    <>
      <button ref={ref} type="button" className="chip-btn" disabled={disabled} title={title} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {trigger(open)}
      </button>
      <Popover anchor={ref} open={open} onClose={close} align={align}>
        <MenuList items={items} onClose={close} />
      </Popover>
    </>
  );
}

/** Open dialogs, topmost last: only the topmost handles Esc and the Tab trap (a confirm opened over Settings, say). */
const dialogStack: object[] = [];
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Dialog({ open, onClose, title, label, children, width = 520, footer, className = '' }: {
  open: boolean; onClose: () => void; title?: ReactNode; /** accessible name when there is no string title */ label?: string; children: ReactNode; width?: number; footer?: ReactNode; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const f = ref.current?.querySelector<HTMLElement>('[autofocus],input,textarea,select,button.primary');
      (f ?? ref.current)?.focus();
    }, 20);
    return () => { clearTimeout(t); prev?.focus?.(); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const token = {};
    dialogStack.push(token);
    const k = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== token) return;
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab') return;
      // focus trap: Tab and Shift+Tab cycle inside the dialog
      const root = ref.current;
      if (!root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (!items.length) { e.preventDefault(); root.focus(); return; }
      const first = items[0], last = items[items.length - 1], cur = document.activeElement;
      if (!root.contains(cur) || cur === root) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', k, true);
    return () => { document.removeEventListener('keydown', k, true); const i = dialogStack.indexOf(token); if (i >= 0) dialogStack.splice(i, 1); };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`dialog ${className}`} role="dialog" aria-modal="true" aria-label={label ?? (typeof title === 'string' ? title : undefined)} style={{ width }} tabIndex={-1}>
        {title && <div className="dialog-head"><h2>{title}</h2><IconButton icon="x" label="Close" onClick={onClose} /></div>}
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string; icon?: IconName; disabled?: boolean; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={value === o.id ? 'on' : ''} disabled={o.disabled} title={o.title} onClick={() => onChange(o.id)}>
          {o.icon && <Icon name={o.icon} size={14} />}{o.label}
        </button>
      ))}
    </div>
  );
}

/** Drag handle for resizing panes. `dir` = which side of the pane the handle is on. */
export function Resizer({ onDrag, onDone, label }: { onDrag: (dx: number) => void; onDone?: () => void; label: string }) {
  const start = useRef(0);
  return (
    <div
      className="resizer" role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        start.current = e.clientX;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        document.body.classList.add('resizing');
        const move = (ev: PointerEvent) => { onDrag(ev.clientX - start.current); start.current = ev.clientX; };
        const up = () => { document.body.classList.remove('resizing'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); onDone?.(); };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
      onKeyDown={(e) => { if (e.key === 'ArrowLeft') onDrag(-16); if (e.key === 'ArrowRight') onDrag(16); }}
    />
  );
}

/** "+3 −1" line counts. Zero sides are not shown (no red "−0"); both zero shows nothing. */
export function Stats({ added, removed, className = '' }: { added: number; removed: number; className?: string }) {
  if (!added && !removed) return null;
  return <span className={`stats ${className}`}>{added > 0 && <span className="add">+{added}</span>}{removed > 0 && <span className="del">−{removed}</span>}</span>;
}

/**
 * Text that never overflows its row: when it does not fit, the MIDDLE is cut ("/Users/me/…/plans/plan-x.md"), so the end of a path
 * (the file name) stays visible. The full text is the tooltip.
 */
export function MiddleEllipsis({ text, tail = 14, className = '' }: { text: string; tail?: number; className?: string }) {
  const n = Math.min(tail, Math.max(0, text.length - 1));
  const head = text.slice(0, text.length - n), end = text.slice(text.length - n);
  return <span className={`mid-ell ${className}`} title={text}><span className="mid-head">{head}</span><span className="mid-tail">{end}</span></span>;
}
