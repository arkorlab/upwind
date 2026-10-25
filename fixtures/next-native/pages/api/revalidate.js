export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).end();
  await response.revalidate('/isr');
  response.json({ revalidated: true });
}
