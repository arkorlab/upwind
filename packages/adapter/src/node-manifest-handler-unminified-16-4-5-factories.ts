/** Next.js 16.4.5: fixed whole-factory DATA from two clean offline public server-minification-off builds. */
import type { NodeManifestWholeFactoryData } from './node-manifest-whole-factory-data.ts';

export const HANDLER_UNMINIFIED_IDS_16_4_5 = {
  handler: 2643,
  hoist: 7645,
  routeKind: 5416,
  noFallback: 3695,
  fresh: 3348,
  path: 4747,
  stream: 1111,
  escape: 350,
  telemetry: 1011,
  telemetryExternal: 406,
  crypto: 4799,
};

export const HANDLER_UNMINIFIED_FACTORIES_16_4_5: Readonly<
  Record<string, Omit<NodeManifestWholeFactoryData, 'canonical' | 'selectedOrdinal'>>
> = {
  handler: {
    version: 1,
    originalSha256: 'f462a5fba6ffe2b1b8f4a02585bae71c0d448c678c21eefcd47467f0a2f9a6a5',
    factory: {
      ids: [
        HANDLER_UNMINIFIED_IDS_16_4_5.routeKind,
        HANDLER_UNMINIFIED_IDS_16_4_5.hoist,
        HANDLER_UNMINIFIED_IDS_16_4_5.handler,
      ],
      start: 15_808,
      end: 236_846,
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
        id: HANDLER_UNMINIFIED_IDS_16_4_5.telemetryExternal,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 28_791,
            end: 28_819,
          },
        ],
      },
      {
        ordinal: 1,
        id: HANDLER_UNMINIFIED_IDS_16_4_5.telemetry,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 28_855,
            end: 28_884,
          },
        ],
      },
      {
        ordinal: 2,
        id: HANDLER_UNMINIFIED_IDS_16_4_5.stream,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 76_712,
            end: 76_741,
          },
          {
            kind: 'require',
            start: 77_396,
            end: 77_425,
          },
          {
            kind: 'require',
            start: 150_985,
            end: 151_014,
          },
          {
            kind: 'require',
            start: 152_271,
            end: 152_300,
          },
        ],
      },
      {
        ordinal: 3,
        id: HANDLER_UNMINIFIED_IDS_16_4_5.escape,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 132_252,
            end: 132_280,
          },
        ],
      },
      {
        ordinal: 4,
        id: HANDLER_UNMINIFIED_IDS_16_4_5.path,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 190_738,
            end: 190_767,
          },
          {
            kind: 'require',
            start: 196_404,
            end: 196_433,
          },
        ],
      },
      {
        ordinal: 5,
        id: HANDLER_UNMINIFIED_IDS_16_4_5.fresh,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 191_980,
            end: 192_009,
          },
        ],
      },
      {
        ordinal: 6,
        id: HANDLER_UNMINIFIED_IDS_16_4_5.noFallback,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 193_972,
            end: 194_001,
          },
        ],
      },
      {
        ordinal: 7,
        id: HANDLER_UNMINIFIED_IDS_16_4_5.crypto,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 204_947,
            end: 204_976,
          },
        ],
      },
    ],
  },
  noFallback: {
    version: 1,
    originalSha256: 'f462a5fba6ffe2b1b8f4a02585bae71c0d448c678c21eefcd47467f0a2f9a6a5',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS_16_4_5.noFallback],
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
    originalSha256: 'f462a5fba6ffe2b1b8f4a02585bae71c0d448c678c21eefcd47467f0a2f9a6a5',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS_16_4_5.fresh],
      start: 12_462,
      end: 15_784,
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
    originalSha256: '4292f7dabe1c9e0bca0857aabf0a600b62778fdee9d3d87d7950fe2bca58d083',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS_16_4_5.path],
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
    originalSha256: 'f462a5fba6ffe2b1b8f4a02585bae71c0d448c678c21eefcd47467f0a2f9a6a5',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS_16_4_5.stream],
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
    originalSha256: 'f462a5fba6ffe2b1b8f4a02585bae71c0d448c678c21eefcd47467f0a2f9a6a5',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS_16_4_5.escape],
      start: 576,
      end: 12_452,
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
    originalSha256: '4292f7dabe1c9e0bca0857aabf0a600b62778fdee9d3d87d7950fe2bca58d083',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS_16_4_5.telemetry],
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
    originalSha256: '4292f7dabe1c9e0bca0857aabf0a600b62778fdee9d3d87d7950fe2bca58d083',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS_16_4_5.telemetryExternal],
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
    originalSha256: 'f462a5fba6ffe2b1b8f4a02585bae71c0d448c678c21eefcd47467f0a2f9a6a5',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS_16_4_5.crypto],
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
