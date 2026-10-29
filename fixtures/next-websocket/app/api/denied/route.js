export function GET() {
  return new Response('middleware was bypassed', { status: 500 });
}
