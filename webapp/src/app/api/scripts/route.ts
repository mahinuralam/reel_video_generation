import { NextResponse } from 'next/server';
import { scriptTemplates } from '@/lib/profile';

export const dynamic = 'force-dynamic';

// GET /api/scripts → scripts used before (inputs/scripts/*.txt), newest first, as starting points
export async function GET() {
  return NextResponse.json({ scripts: scriptTemplates() });
}
