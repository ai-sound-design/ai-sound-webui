import type { ComponentType, SVGProps } from 'react';

export {
  AudioLines,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Copy,
  Crop,
  Database,
  Download,
  FilePlus2,
  Flag,
  FolderOpen,
  Import,
  Layers,
  Link2,
  ListPlus,
  LoaderCircle,
  Minus,
  Move,
  PanelRight,
  Play,
  Plus,
  Redo2,
  Repeat,
  Save,
  ScanSearch,
  Scissors,
  Settings2,
  SkipBack,
  Sparkles,
  Square,
  SquareSplitHorizontal,
  TextCursor,
  Trash2,
  Undo2,
  Volume2,
  VolumeX,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

export type IconType = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

/** Custom icons in the same 24 px line style as Lucide, for things Lucide has no symbol for */
function Svg({ size = 16, strokeWidth = 1.75, children, ...rest }: SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      {children}
    </svg>
  );
}

type P = { size?: number; strokeWidth?: number; className?: string };

/** Smart tool: pointer with a selection bracket */
export const SmartTool = (p: P) => (
  <Svg {...p}>
    <path d="M5 3.5l9.5 6.2-4.2.9 2.4 4.9-1.9.9-2.4-4.9-3.2 2.8z" />
    <path d="M17 13v7M15 13h4M15 20h4" />
  </Svg>
);

/** Trim tool: edge bracket with a drag arrow */
export const TrimTool = (p: P) => (
  <Svg {...p}>
    <path d="M9 4H6v16h3" />
    <path d="M12 12h8M17 9l3 3-3 3" />
  </Svg>
);

export const FadeTool = (p: P) => (
  <Svg {...p}>
    <path d="M3 20C8 20 14 14 21 4" />
    <path d="M3 20h18" opacity=".45" />
  </Svg>
);

export const FadeIn = (p: P) => (
  <Svg {...p}>
    <path d="M3 19c4 0 7-9 11-13h7" />
    <path d="M3 19h18" opacity=".45" />
  </Svg>
);

export const FadeOut = (p: P) => (
  <Svg {...p}>
    <path d="M3 6h7c4 4 7 13 11 13" />
    <path d="M3 19h18" opacity=".45" />
  </Svg>
);

export const Crossfade = (p: P) => (
  <Svg {...p}>
    <path d="M3 6c6 0 12 13 18 13" />
    <path d="M3 19c6 0 12-13 18-13" />
  </Svg>
);
