import type { Symptom } from './symptoms.ts';

const SUITE = 'test/e2e/app-dir/avif-svg-signature-confusion/avif-svg-signature-confusion.test.ts';
const RECORD = 'svg-rejection-by-the-image-optimizer';

/** The complete assertion and its first stack frame, never a location quoted in a code excerpt. */
function imageFailureAt(assertion: string, matcher: string, position: string): Symptom {
  const prefix = `${assertion}\n`;
  return (message) => {
    if (!message.startsWith(prefix)) return false;
    const [frame] = message.slice(prefix.length).split('\n', 1);
    return (
      frame?.startsWith(`    at Object.${matcher} (`) === true &&
      frame.endsWith(`/${SUITE}:${position})`)
    );
  };
}

/** Vercel image CDN expectations, observed only at 16.4.5 on node under Node.js 24. */
export const IMAGE_CDN_16_4_5 = [
  {
    reading: 'vercel',
    record: RECORD,
    targets: ['node'],
    nodes: ['24'],
    symptom: imageFailureAt(
      [
        'Error: expect(received).toContain(expected) // indexOf',
        '',
        'Expected substring: "INVALID_IMAGE_OPTIMIZE_REQUEST"',
        String.raw`Received string:    "\"url\" parameter is valid but image type is not allowed"`,
      ].join('\n'),
      'toContain',
      '17:32',
    ),
    cases: {
      [SUITE]: [
        'avif-svg-signature-confusion rejects an ordinary SVG when dangerouslyAllowSVG is false',
      ],
    },
  },
  {
    reading: 'vercel',
    record: RECORD,
    targets: ['node'],
    nodes: ['24'],
    symptom: imageFailureAt(
      [
        'Error: expect(received).toBe(expected) // Object.is equality',
        '',
        'Expected: 200',
        'Received: 400',
      ].join('\n'),
      'toBe',
      '34:26',
    ),
    cases: {
      [SUITE]: ['avif-svg-signature-confusion rejects an SVG prefixed with <!--ftypavif-->'],
    },
  },
] as const;
