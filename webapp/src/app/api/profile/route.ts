import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongo';
import { getProfile } from '@/lib/profile';

export const dynamic = 'force-dynamic';

// GET /api/profile → saved images (photos) and voices, with the defaults
export async function GET() {
  return NextResponse.json(await getProfile(await getDb()));
}
