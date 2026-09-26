// A Pages Router API route: its body parser is the one that reaches `next/dist/compiled/raw-body`,
// which the Function resolves to the adapter's own copy.
export default function handler(request, response) {
  response.status(200).json({ body: request.body ?? null });
}
