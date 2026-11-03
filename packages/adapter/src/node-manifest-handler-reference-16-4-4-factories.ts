/** Next.js 16.4.4: fixed reference DATA from the marker-free, independently compiled public Pages fixture. */
import type { NodeManifestWholeFactoryData } from './node-manifest-whole-factory-data.ts';

export const HANDLER_REFERENCE_IDS_16_4_4 = {
  handler: 4651,
  hoist: 7511,
  routeKind: 6084,
  noFallback: 3695,
  fresh: 7284,
  path: 4747,
  stream: 1111,
  escape: 3859,
  telemetry: 4309,
  telemetryExternal: 406,
};

export const HANDLER_REFERENCE_FACTORIES_16_4_4: Readonly<
  Record<string, Omit<NodeManifestWholeFactoryData, 'canonical' | 'selectedOrdinal'>>
> = {
  handler: {
    version: 1,
    originalSha256: '01419aace9d59237fd817479d45ed3ba99e18e4fa48313ae618d4d9e6b8704e7',
    factory: {
      ids: [
        HANDLER_REFERENCE_IDS_16_4_4.routeKind,
        HANDLER_REFERENCE_IDS_16_4_4.hoist,
        HANDLER_REFERENCE_IDS_16_4_4.handler,
      ],
      start: 6306,
      end: 40_437,
    },
    strictContext: {
      effective: true,
      scopes: [
        {
          type: 'Program',
          directives: [],
        },
        {
          type: 'ArrowFunctionExpression',
          directives: [
            {
              raw: '"use strict"',
              value: 'use strict',
            },
          ],
        },
      ],
    },
    ports: [
      {
        ordinal: 0,
        id: HANDLER_REFERENCE_IDS_16_4_4.telemetryExternal,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 11_447,
            end: 11_455,
          },
        ],
      },
      {
        ordinal: 1,
        id: HANDLER_REFERENCE_IDS_16_4_4.telemetry,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 11_467,
            end: 11_476,
          },
        ],
      },
      {
        ordinal: 2,
        id: HANDLER_REFERENCE_IDS_16_4_4.escape,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 22_603,
            end: 22_612,
          },
        ],
      },
      {
        ordinal: 3,
        id: HANDLER_REFERENCE_IDS_16_4_4.stream,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 26_360,
            end: 26_369,
          },
          {
            kind: 'require',
            start: 26_618,
            end: 26_627,
          },
        ],
      },
      {
        ordinal: 4,
        id: HANDLER_REFERENCE_IDS_16_4_4.path,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 29_431,
            end: 29_440,
          },
        ],
      },
      {
        ordinal: 5,
        id: HANDLER_REFERENCE_IDS_16_4_4.fresh,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 29_444,
            end: 29_453,
          },
        ],
      },
      {
        ordinal: 6,
        id: HANDLER_REFERENCE_IDS_16_4_4.noFallback,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 30_458,
            end: 30_467,
          },
        ],
      },
    ],
  },
  noFallback: {
    version: 1,
    originalSha256: '01419aace9d59237fd817479d45ed3ba99e18e4fa48313ae618d4d9e6b8704e7',
    factory: {
      ids: [HANDLER_REFERENCE_IDS_16_4_4.noFallback],
      start: 83,
      end: 227,
    },
    strictContext: {
      effective: false,
      scopes: [
        {
          type: 'Program',
          directives: [],
        },
        {
          type: 'ArrowFunctionExpression',
          directives: [],
        },
      ],
    },
    ports: [],
  },
  fresh: {
    version: 1,
    originalSha256: '01419aace9d59237fd817479d45ed3ba99e18e4fa48313ae618d4d9e6b8704e7',
    factory: {
      ids: [HANDLER_REFERENCE_IDS_16_4_4.fresh],
      start: 5237,
      end: 6290,
    },
    strictContext: {
      effective: false,
      scopes: [
        {
          type: 'Program',
          directives: [],
        },
        {
          type: 'ArrowFunctionExpression',
          directives: [],
        },
      ],
    },
    ports: [],
  },
  path: {
    version: 1,
    originalSha256: 'b5c9dc82fec7831e8999540a43771024e2a023f671f7c5e3b39b07d573732961',
    factory: {
      ids: [HANDLER_REFERENCE_IDS_16_4_4.path],
      start: 310,
      end: 362,
    },
    strictContext: {
      effective: false,
      scopes: [
        {
          type: 'Program',
          directives: [],
        },
        {
          type: 'ArrowFunctionExpression',
          directives: [],
        },
      ],
    },
    ports: [],
  },
  stream: {
    version: 1,
    originalSha256: '01419aace9d59237fd817479d45ed3ba99e18e4fa48313ae618d4d9e6b8704e7',
    factory: {
      ids: [HANDLER_REFERENCE_IDS_16_4_4.stream],
      start: 233,
      end: 299,
    },
    strictContext: {
      effective: false,
      scopes: [
        {
          type: 'Program',
          directives: [],
        },
        {
          type: 'ArrowFunctionExpression',
          directives: [],
        },
      ],
    },
    ports: [],
  },
  escape: {
    version: 1,
    originalSha256: '01419aace9d59237fd817479d45ed3ba99e18e4fa48313ae618d4d9e6b8704e7',
    factory: {
      ids: [HANDLER_REFERENCE_IDS_16_4_4.escape],
      start: 305,
      end: 5231,
    },
    strictContext: {
      effective: true,
      scopes: [
        {
          type: 'Program',
          directives: [],
        },
        {
          type: 'ArrowFunctionExpression',
          directives: [
            {
              raw: '"use strict"',
              value: 'use strict',
            },
          ],
        },
      ],
    },
    ports: [],
  },
  telemetry: {
    version: 1,
    originalSha256: 'b5c9dc82fec7831e8999540a43771024e2a023f671f7c5e3b39b07d573732961',
    factory: {
      ids: [HANDLER_REFERENCE_IDS_16_4_4.telemetry],
      start: 368,
      end: 24_653,
    },
    strictContext: {
      effective: false,
      scopes: [
        {
          type: 'Program',
          directives: [],
        },
        {
          type: 'ArrowFunctionExpression',
          directives: [],
        },
      ],
    },
    ports: [],
  },
  telemetryExternal: {
    version: 1,
    originalSha256: 'b5c9dc82fec7831e8999540a43771024e2a023f671f7c5e3b39b07d573732961',
    factory: {
      ids: [HANDLER_REFERENCE_IDS_16_4_4.telemetryExternal],
      start: 20,
      end: 138,
    },
    strictContext: {
      effective: false,
      scopes: [
        {
          type: 'Program',
          directives: [],
        },
        {
          type: 'ArrowFunctionExpression',
          directives: [],
        },
      ],
    },
    ports: [],
  },
};
