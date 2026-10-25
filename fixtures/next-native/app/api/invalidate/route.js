import { revalidateTag } from 'next/cache';

export async function POST() {
  revalidateTag('native-value', { expire: 0 });
  return Response.json({ invalidated: true });
}
