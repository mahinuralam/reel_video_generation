'use client';
// Browser helpers: polling, JSON calls and display formatting.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobStatus } from './types';

/** Fetch a JSON URL now and then every `ms` (0 = once). `reload()` fetches again at once. */
export function usePoll<T>(url: string | null, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const msRef = useRef(ms);
  msRef.current = ms;
  const polling = ms > 0; // switching polling on (or off) fetches again at once

  useEffect(() => {
    if (!url) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        const j = await r.json();
        if (!alive) return;
        if (!r.ok) setError(j.error || r.statusText);
        else { setData(j); setError(null); }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
      if (alive && msRef.current > 0) timer = setTimeout(load, msRef.current);
    };
    load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [url, nonce, polling]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, reload };
}

export async function api<T = unknown>(url: string, method = 'GET', body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: data as T };
}

export function fileUrl(relPath: string, download = false): string {
  return '/api/files/' + relPath.split('/').map(encodeURIComponent).join('/') + (download ? '?download=1' : '');
}

export function fmtWhen(iso?: string | null): string {
  if (!iso) return '–';
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

export function elapsedSec(fromIso?: string | null, toIso?: string | null): number | null {
  if (!fromIso) return null;
  return ((toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime()) / 1000;
}

export const STATUS_LABEL: Record<JobStatus, string> = { queued: 'Queued', running: 'Rendering', done: 'Done', failed: 'Failed', canceled: 'Canceled' };
