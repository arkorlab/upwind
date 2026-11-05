/** Next.js 16.4.4: fixed whole-factory DATA from two clean offline public server-minification-off builds. */
import type { NodeManifestWholeFactoryData } from './node-manifest-whole-factory-data.ts';

export const HANDLER_UNMINIFIED_IDS_16_4_4 = {
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
  crypto: 4799,
};

export const HANDLER_UNMINIFIED_FACTORIES_16_4_4: Readonly<
  Record<string, Omit<NodeManifestWholeFactoryData, 'canonical' | 'selectedOrdinal'>>
> = {
  handler: {
    version: 1,
    originalSha256: '0d1c836fd1208b1b9e935c5aedfad00b82f45c90471e50bf17b7bb5e2ffc3b60',
    factory: {
      ids: [
        HANDLER_UNMINIFIED_IDS_16_4_4.routeKind,
        HANDLER_UNMINIFIED_IDS_16_4_4.hoist,
        HANDLER_UNMINIFIED_IDS_16_4_4.handler,
      ],
      start: 15_809,
      end: 236_852,
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
        id: HANDLER_UNMINIFIED_IDS_16_4_4.telemetryExternal,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 28_792,
            end: 28_820,
          },
        ],
      },
      {
        ordinal: 1,
        id: HANDLER_UNMINIFIED_IDS_16_4_4.telemetry,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 28_856,
            end: 28_885,
          },
        ],
      },
      {
        ordinal: 2,
        id: HANDLER_UNMINIFIED_IDS_16_4_4.stream,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 76_713,
            end: 76_742,
          },
          {
            kind: 'require',
            start: 77_397,
            end: 77_426,
          },
          {
            kind: 'require',
            start: 150_991,
            end: 151_020,
          },
          {
            kind: 'require',
            start: 152_277,
            end: 152_306,
          },
        ],
      },
      {
        ordinal: 3,
        id: HANDLER_UNMINIFIED_IDS_16_4_4.escape,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 132_254,
            end: 132_283,
          },
        ],
      },
      {
        ordinal: 4,
        id: HANDLER_UNMINIFIED_IDS_16_4_4.path,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 190_744,
            end: 190_773,
          },
          {
            kind: 'require',
            start: 196_410,
            end: 196_439,
          },
        ],
      },
      {
        ordinal: 5,
        id: HANDLER_UNMINIFIED_IDS_16_4_4.fresh,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 191_986,
            end: 192_015,
          },
        ],
      },
      {
        ordinal: 6,
        id: HANDLER_UNMINIFIED_IDS_16_4_4.noFallback,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 193_978,
            end: 194_007,
          },
        ],
      },
      {
        ordinal: 7,
        id: HANDLER_UNMINIFIED_IDS_16_4_4.crypto,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 204_953,
            end: 204_982,
          },
        ],
      },
    ],
  },
  noFallback: {
    version: 1,
    originalSha256: '0d1c836fd1208b1b9e935c5aedfad00b82f45c90471e50bf17b7bb5e2ffc3b60',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS_16_4_4.noFallback],
      start: 177,
      end: 406,
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
    originalSha256: '0d1c836fd1208b1b9e935c5aedfad00b82f45c90471e50bf17b7bb5e2ffc3b60',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS_16_4_4.fresh],
      start: 12_463,
      end: 15_785,
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
    originalSha256: '3c4327fdf5df7c1e19a5963e8ed3b8cde2cb1f1bd6c9b097225e45e0d7549dfb',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS_16_4_4.path],
      start: 493,
      end: 630,
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
    originalSha256: '0d1c836fd1208b1b9e935c5aedfad00b82f45c90471e50bf17b7bb5e2ffc3b60',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS_16_4_4.stream],
      start: 416,
      end: 567,
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
    originalSha256: '0d1c836fd1208b1b9e935c5aedfad00b82f45c90471e50bf17b7bb5e2ffc3b60',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS_16_4_4.escape],
      start: 577,
      end: 12_453,
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
    originalSha256: '3c4327fdf5df7c1e19a5963e8ed3b8cde2cb1f1bd6c9b097225e45e0d7549dfb',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS_16_4_4.telemetry],
      start: 640,
      end: 55_514,
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
    originalSha256: '3c4327fdf5df7c1e19a5963e8ed3b8cde2cb1f1bd6c9b097225e45e0d7549dfb',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS_16_4_4.telemetryExternal],
      start: 25,
      end: 228,
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
  crypto: {
    version: 1,
    originalSha256: '0d1c836fd1208b1b9e935c5aedfad00b82f45c90471e50bf17b7bb5e2ffc3b60',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS_16_4_4.crypto],
      start: 26,
      end: 167,
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
