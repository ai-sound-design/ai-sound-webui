import { forwardRef, useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { IconType } from './icons';

type Variant = 'default' | 'outline' | 'primary' | 'ghost';

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: IconType;
  label?: ReactNode;
  /** Tooltip text; shown by <TooltipHost> */
  tip?: string;
  kbd?: string;
  variant?: Variant;
  active?: boolean;
  size?: 'sm' | 'md';
}

/** The one button used everywhere: icon, label or both, with tooltip and shortcut hint */
export const Btn = forwardRef<HTMLButtonElement, BtnProps>(function Btn({ icon: Icon, label, tip, kbd, variant = 'default', active, size = 'md', className = '', children, ...rest }, ref) {
  const iconOnly = Icon && !label && !children;
  return (
    <button
      ref={ref}
      type="button"
      className={`btn btn-${variant} btn-${size} ${iconOnly ? 'btn-icon' : ''} ${active ? 'is-active' : ''} ${className}`}
      data-tip={tip}
      data-kbd={kbd}
      aria-label={iconOnly ? tip : undefined}
      aria-pressed={active}
      {...rest}
    >
      {Icon && <Icon size={size === 'sm' ? 14 : 16} strokeWidth={1.75} />}
      {label && <span>{label}</span>}
      {children}
    </button>
  );
});

export function Group({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`group ${className}`}>{children}</div>;
}

export function Divider() {
  return <span className="divider" />;
}

/**
 * One tooltip for the whole app: follows elements with `data-tip` (and optional
 * `data-kbd`), positioned in a fixed layer so scroll containers never clip it.
 */
export function TooltipHost() {
  const [tip, setTip] = useState<{ text: string; kbd?: string; x: number; y: number; below: boolean } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | null = null;
    const over = (e: PointerEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
      if (el === current) return;
      current = el;
      clearTimeout(timer);
      setTip(null);
      if (!el || !el.dataset.tip) return;
      timer = setTimeout(() => {
        const r = el.getBoundingClientRect();
        const below = r.top < 60;
        setTip({ text: el.dataset.tip!, kbd: el.dataset.kbd || undefined, x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below });
      }, 450);
    };
    const hide = () => {
      clearTimeout(timer);
      current = null;
      setTip(null);
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerdown', hide);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerdown', hide);
      window.removeEventListener('blur', hide);
    };
  }, []);
  if (!tip) return null;
  return (
    <div className={`tooltip ${tip.below ? 'below' : 'above'}`} style={{ left: Math.min(window.innerWidth - 12, Math.max(12, tip.x)), top: tip.y }} role="tooltip">
      {tip.text}
      {tip.kbd && <kbd>{tip.kbd}</kbd>}
    </div>
  );
}
