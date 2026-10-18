import type { CSSProperties } from 'react';

const P: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-up': 'M6 15l6-6 6 6',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  'folder-open': 'M3 8V6a2 2 0 012-2h4l2 2h7a2 2 0 012 2v2M3 10h18l-2 8a2 2 0 01-2 1.5H5A2 2 0 013 18z',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  'file-plus': 'M7 3h7l5 5v13H7zM14 3v5h5M12 12v6M9 15h6',
  'file-edit': 'M7 3h7l5 5v6M14 3v5h5M7 21V3M10 20l1-3 7-7 2 2-7 7z',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  pencil: 'M4 20l1-4L16 5l3 3L8 19zM14 7l3 3',
  branch: 'M6 4v12M6 20a2 2 0 100-4 2 2 0 000 4zM18 8a2 2 0 100-4 2 2 0 000 4zM18 8c0 5-6 4-12 8',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6',
  sidebar: 'M4 5h16v14H4zM9 5v14',
  'panel-right': 'M4 5h16v14H4zM15 5v14',
  stop: 'M7 7h10v10H7z',
  'arrow-up': 'M12 19V5M5 12l7-7 7 7',
  paperclip: 'M20 11l-8.5 8.5a5 5 0 01-7-7L13 4a3.3 3.3 0 014.7 4.7L9.2 17.200a1.700 1.700 0 01-2.400-2.400L14 7.500',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9.500h.01',
  sparkles: 'M12 3l1.8 5.200L19 10l-5.200 1.800L12 17l-1.800-5.200L5 10l5.200-1.800zM19 17l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z',
  list: 'M9 6h11M9 12h11M9 18h11M4.500 6h.01M4.500 12h.01M4.500 18h.01',
  'list-checks': 'M10 6h10M10 12h10M10 18h10M3.500 6.500l1.500 1.500 2.500-3M3.500 12.500L5 14l2.500-3M3.500 18.500L5 20l2.500-3',
  globe: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  brain: 'M9 4a3 3 0 00-3 3 3 3 0 00-2 5 3 3 0 002 5 3 3 0 006 0V4a3 3 0 00-3 0zM15 4a3 3 0 013 3 3 3 0 012 5 3 3 0 01-2 5 3 3 0 01-6 0',
  wrench: 'M14.500 6.500a4 4 0 005 5L20 12l-8 8a2.100 2.100 0 01-3-3l8-8z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9.500a2.500 2.500 0 100 5 2.500 2.500 0 000-5z',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  sun: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M4.900 4.900l1.400 1.400M17.700 17.700l1.400 1.400M2 12h2M20 12h2M4.900 19.100l1.400-1.400M17.700 6.300l1.400-1.400',
  moon: 'M20 14.500A8 8 0 019.500 4 8 8 0 1020 14.500z',
  monitor: 'M3 5h18v12H3zM8 21h8M12 17v4',
  command: 'M9 9V6a3 3 0 10-3 3h3zm0 0h6m-6 0v6m6-6V6a3 3 0 113 3h-3zm0 0v6m0 0h3a3 3 0 11-3 3v-3zm0 0H9m0 0v3a3 3 0 11-3-3h3z',
  alert: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  info: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v5M12 8h.01',
  clock: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 2',
  bot: 'M5 8h14v11H5zM12 4v4M9 13h.01M15 13h.01M3 13v3M21 13v3',
  zap: 'M13 3L5 14h6l-1 7 8-11h-6z',
  shield: 'M12 3l8 3v6c0 5-3.500 8-8 9-4.500-1-8-4-8-9V6z',
  'help': 'M12 3a9 9 0 100 18 9 9 0 000-18zM9.500 9.500a2.500 2.500 0 114 2c-.8.6-1.500 1-1.500 2M12 17h.01',
  mic: 'M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM6 11a6 6 0 0012 0M12 17v4',
  refresh: 'M20 11a8 8 0 00-14-4L4 9M4 4v5h5M4 13a8 8 0 0014 4l2-2M20 20v-5h-5',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5',
  'chat': 'M4 5h16v11H9l-5 4z',
  fork: 'M7 4v6a3 3 0 003 3h4a3 3 0 003-3V4M12 13v7',
  settings: 'M12 9a3 3 0 100 6 3 3 0 000-6zM19 12l2-1.500-2-3.500-2.400.8-1.600-1L14.500 4h-4L10 6.800l-1.600 1L6 7 4 10.500 6 12v0l-2 1.500L6 17l2.400-.8 1.600 1 .5 2.800h4l.5-2.800 1.600-1 2.400.8 2-3.500z',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17.500l9 5 9-5',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4',
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  logs: 'M5 4h14v16H5zM8.500 9h7M8.500 13h7M8.500 17h4',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 15, className, style, fill }: { name: IconName; size?: number; className?: string; style?: CSSProperties; fill?: boolean }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" className={`icon${className ? ' ' + className : ''}`} style={style}
      fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d={P[name] ?? P.info} />
    </svg>
  );
}
