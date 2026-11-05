/** Next.js 16.4.5: fixed reference DATA from the marker-free, independently compiled public Pages fixture. */
import type { NodeManifestWholeFactoryData } from './node-manifest-whole-factory-data.ts';

export const HANDLER_REFERENCE_IDS_16_4_5 = {
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
};

export const HANDLER_REFERENCE_FACTORIES_16_4_5: Readonly<
  Record<string, Omit<NodeManifestWholeFactoryData, 'canonical' | 'selectedOrdinal'>>
> = {
  handler: {
    version: 1,
    originalSha256: '10b82a622375a1b17b4d90c5371168c95b9628d420872d3e7db5e9677d4d2937',
    factory: {
      ids: [
        HANDLER_REFERENCE_IDS_16_4_5.routeKind,
        HANDLER_REFERENCE_IDS_16_4_5.hoist,
        HANDLER_REFERENCE_IDS_16_4_5.handler,
      ],
      start: 6305,
      end: 40_435,
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
        id: HANDLER_REFERENCE_IDS_16_4_5.telemetryExternal,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 11_446,
            end: 11_454,
          },
        ],
      },
      {
        ordinal: 1,
        id: HANDLER_REFERENCE_IDS_16_4_5.telemetry,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 11_466,
            end: 11_475,
          },
        ],
      },
      {
        ordinal: 2,
        id: HANDLER_REFERENCE_IDS_16_4_5.escape,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 22_602,
            end: 22_610,
          },
        ],
      },
      {
        ordinal: 3,
        id: HANDLER_REFERENCE_IDS_16_4_5.stream,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 26_358,
            end: 26_367,
          },
          {
            kind: 'require',
            start: 26_616,
            end: 26_625,
          },
        ],
      },
      {
        ordinal: 4,
        id: HANDLER_REFERENCE_IDS_16_4_5.path,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 29_429,
            end: 29_438,
          },
        ],
      },
      {
        ordinal: 5,
        id: HANDLER_REFERENCE_IDS_16_4_5.fresh,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 29_442,
            end: 29_451,
          },
        ],
      },
      {
        ordinal: 6,
        id: HANDLER_REFERENCE_IDS_16_4_5.noFallback,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 30_456,
            end: 30_465,
          },
        ],
      },
    ],
  },
  noFallback: {
    version: 1,
    originalSha256: '10b82a622375a1b17b4d90c5371168c95b9628d420872d3e7db5e9677d4d2937',
    factory: {
      ids: [HANDLER_REFERENCE_IDS_16_4_5.noFallback],
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
    originalSha256: '10b82a622375a1b17b4d90c5371168c95b9628d420872d3e7db5e9677d4d2937',
    factory: {
      ids: [HANDLER_REFERENCE_IDS_16_4_5.fresh],
      start: 5236,
      end: 6289,
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
    originalSha256: 'cbf420431ecdb30d6b327f1f84bfc6ef23a280580e4f8f09983ae9466bca86c3',
    factory: {
      ids: [HANDLER_REFERENCE_IDS_16_4_5.path],
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
    originalSha256: '10b82a622375a1b17b4d90c5371168c95b9628d420872d3e7db5e9677d4d2937',
    factory: {
      ids: [HANDLER_REFERENCE_IDS_16_4_5.stream],
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
    originalSha256: '10b82a622375a1b17b4d90c5371168c95b9628d420872d3e7db5e9677d4d2937',
    factory: {
      ids: [HANDLER_REFERENCE_IDS_16_4_5.escape],
      start: 304,
      end: 5230,
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
    originalSha256: 'cbf420431ecdb30d6b327f1f84bfc6ef23a280580e4f8f09983ae9466bca86c3',
    factory: {
      ids: [HANDLER_REFERENCE_IDS_16_4_5.telemetry],
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
    originalSha256: 'cbf420431ecdb30d6b327f1f84bfc6ef23a280580e4f8f09983ae9466bca86c3',
    factory: {
      ids: [HANDLER_REFERENCE_IDS_16_4_5.telemetryExternal],
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
