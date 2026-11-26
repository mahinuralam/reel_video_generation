// Stroke icons used across the app (24x24 grid, currentColor).
const PATHS: Record<string, string> = {
  sparkles: 'M11 3l1.8 4.7 4.7 1.8-4.7 1.8L11 16l-1.8-4.7-4.7-1.8 4.7-1.8zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  video: 'M2 7a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zM16 10l6-3v10l-6-3z',
  image: 'M4 4h16v16H4zM4 16l5-5 4 4 2-2 5 5M15 9.5a1.5 1.5 0 1 0 0-.01',
  check: 'M5 12l5 5L20 7',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  upload: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  mic: 'M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0zM5 11a7 7 0 0 0 14 0M12 18v3',
  stop: 'M7 7h10v10H7z',
  alert: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  x: 'M6 6l12 12M18 6L6 18',
  retry: 'M4 4v6h6M20 20v-6h-6M5 15a7 7 0 0 0 12 3M19 9A7 7 0 0 0 7 6',
};

export function Icon({ name, size = 18, strokeWidth = 2 }: { name: keyof typeof PATHS | string; size?: number; strokeWidth?: number }) {
  if (name === 'play') {
    return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>;
  }
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name] || ''} />
    </svg>
  );
}
