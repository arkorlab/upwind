/** Fixed whole-factory DATA from two clean offline public server-minification-off builds. */
import type { NodeManifestWholeFactoryData } from './node-manifest-whole-factory-data.ts';

export const HANDLER_UNMINIFIED_IDS = {
  handler: 8161,
  hoist: 405,
  routeKind: 3013,
  noFallback: 3695,
  fresh: 5148,
  path: 4747,
  stream: 1111,
  escape: 7416,
  telemetry: 5675,
  telemetryExternal: 406,
  crypto: 4799,
};

export const HANDLER_UNMINIFIED_FACTORIES: Readonly<
  Record<string, Omit<NodeManifestWholeFactoryData, 'canonical' | 'selectedOrdinal'>>
> = {
  handler: {
    version: 1,
    originalSha256: '93f49c68e4d98731c561d5e9b6397f80839c4e8f2a4ce2314a5a26545e0aa0b4',
    factory: {
      ids: [
        HANDLER_UNMINIFIED_IDS.routeKind,
        HANDLER_UNMINIFIED_IDS.hoist,
        HANDLER_UNMINIFIED_IDS.handler,
      ],
      start: 15_808,
      end: 236_850,
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
        id: HANDLER_UNMINIFIED_IDS.telemetryExternal,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 28_790,
            end: 28_818,
          },
        ],
      },
      {
        ordinal: 1,
        id: HANDLER_UNMINIFIED_IDS.telemetry,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 28_854,
            end: 28_883,
          },
        ],
      },
      {
        ordinal: 2,
        id: HANDLER_UNMINIFIED_IDS.stream,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 76_711,
            end: 76_740,
          },
          {
            kind: 'require',
            start: 77_395,
            end: 77_424,
          },
          {
            kind: 'require',
            start: 150_989,
            end: 151_018,
          },
          {
            kind: 'require',
            start: 152_275,
            end: 152_304,
          },
        ],
      },
      {
        ordinal: 3,
        id: HANDLER_UNMINIFIED_IDS.escape,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 132_252,
            end: 132_281,
          },
        ],
      },
      {
        ordinal: 4,
        id: HANDLER_UNMINIFIED_IDS.path,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 190_742,
            end: 190_771,
          },
          {
            kind: 'require',
            start: 196_408,
            end: 196_437,
          },
        ],
      },
      {
        ordinal: 5,
        id: HANDLER_UNMINIFIED_IDS.fresh,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 191_984,
            end: 192_013,
          },
        ],
      },
      {
        ordinal: 6,
        id: HANDLER_UNMINIFIED_IDS.noFallback,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 193_976,
            end: 194_005,
          },
        ],
      },
      {
        ordinal: 7,
        id: HANDLER_UNMINIFIED_IDS.crypto,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 204_951,
            end: 204_980,
          },
        ],
      },
    ],
  },
  noFallback: {
    version: 1,
    originalSha256: '93f49c68e4d98731c561d5e9b6397f80839c4e8f2a4ce2314a5a26545e0aa0b4',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS.noFallback],
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
    originalSha256: '93f49c68e4d98731c561d5e9b6397f80839c4e8f2a4ce2314a5a26545e0aa0b4',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS.fresh],
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
    originalSha256: '5cb2f99ce8b3e36bb4d9db643fef9e04f50f33d1c5b5a84338550137ebe9bf83',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS.path],
      start: 117_645,
      end: 117_782,
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
    originalSha256: '93f49c68e4d98731c561d5e9b6397f80839c4e8f2a4ce2314a5a26545e0aa0b4',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS.stream],
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
    originalSha256: '93f49c68e4d98731c561d5e9b6397f80839c4e8f2a4ce2314a5a26545e0aa0b4',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS.escape],
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
    originalSha256: '5cb2f99ce8b3e36bb4d9db643fef9e04f50f33d1c5b5a84338550137ebe9bf83',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS.telemetry],
      start: 117_792,
      end: 172_666,
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
    originalSha256: '5cb2f99ce8b3e36bb4d9db643fef9e04f50f33d1c5b5a84338550137ebe9bf83',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS.telemetryExternal],
      start: 117_177,
      end: 117_380,
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
    originalSha256: '93f49c68e4d98731c561d5e9b6397f80839c4e8f2a4ce2314a5a26545e0aa0b4',
    factory: {
      ids: [HANDLER_UNMINIFIED_IDS.crypto],
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
