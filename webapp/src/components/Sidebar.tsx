'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { usePoll } from '@/lib/client';
import type { WorkerInfo } from '@/lib/types';
import { Icon } from './Icon';

const LINKS = [
  { href: '/', label: 'Create', icon: 'sparkles' },
  { href: '/library', label: 'Videos', icon: 'video' },
];

type Status = { worker: WorkerInfo };

export function Sidebar() {
  const path = usePathname();
  const { data } = usePoll<Status>('/api/status', 4000);
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href) || (href === '/library' && path.startsWith('/jobs')));

  return (
    <nav className="nav" aria-label="Main">
      <Link href="/" className="brand" aria-label="Avatar Studio home">
        <span className="brand-mark"><Icon name="play" size={16} /></span>
        <span className="brand-name">Avatar Studio</span>
      </Link>
      <div className="nav-links">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} aria-current={active(l.href) ? 'page' : undefined}>
            <Icon name={l.icon} />{l.label}
          </Link>
        ))}
      </div>
      {data?.worker.mock ? <span className="mock-flag">Mock mode: no API calls</span> : null}
    </nav>
  );
}
