import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';
import type { SessionStatus } from '../store/sessions';
import { platform } from '../platform';

export function StatusDot({ status, size = 8 }: { status: SessionStatus; size?: number }) {
  const label = { running: 'Running', 'needs-input': 'Needs your input', error: 'Error', done: 'Finished (unread)', idle: 'Idle', starting: 'Starting' }[status];
  return <span className={`dot dot-${status}`} style={{ width: size, height: size }} role="img" aria-label={label} title={label} />;
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="Working" />;
}

/** Three animated violet dots: "the agent is doing something" (violet is reserved for agent surfaces). */
export function Dots() {
  return <span className="dots" role="status" aria-label="Working"><i /><i /><i /></span>;
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

export function useOutsideClose(ref: React.RefObject<HTMLElement>, onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [ref, onClose, active]);
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

/** Anchored popover rendered in a portal, flips above/below. */
export function Popover({ anchor, open, onClose, children, align = 'start', width, className = '' }: {
  anchor: React.RefObject<HTMLElement>; open: boolean; onClose: () => void; children: ReactNode; align?: 'start' | 'end'; width?: number; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' });
  useOutsideClose(ref, onClose, open);
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 240;
    const w = ref.current?.offsetWidth ?? width ?? 240;
    const below = window.innerHeight - r.bottom > h + 12 || r.top < h + 12;
    const left = align === 'end' ? Math.max(8, r.right - w) : Math.min(r.left, window.innerWidth - w - 8);
    setPos({ position: 'fixed', left, top: below ? r.bottom + 6 : undefined, bottom: below ? undefined : window.innerHeight - r.top + 6, minWidth: width });
  }, [open, anchor, align, width]);
  if (!open) return null;
  return createPortal(<div ref={ref} className={`popover ${className}`} style={pos}>{children}</div>, document.body);
}

export function Dropdown({ trigger, items, align = 'start', disabled, title }: {
  trigger: (open: boolean) => ReactNode; items: MenuEntry[]; align?: 'start' | 'end'; disabled?: boolean; title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} type="button" className="chip-btn" disabled={disabled} title={title} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {trigger(open)}
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} align={align}>
        <MenuList items={items} onClose={() => setOpen(false)} />
      </Popover>
    </>
  );
}

export function Dialog({ open, onClose, title, children, width = 520, footer, className = '' }: {
  open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; width?: number; footer?: ReactNode; className?: string;
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
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', k, true);
    return () => document.removeEventListener('keydown', k, true);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`dialog ${className}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} style={{ width }} tabIndex={-1}>
        {title && <div className="dialog-head"><h2>{title}</h2><IconButton icon="x" label="Close" onClick={onClose} /></div>}
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string; icon?: IconName }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}>
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
