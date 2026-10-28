/** Fixed reference DATA from the marker-free, independently compiled public Pages fixture. */
import type { NodeManifestWholeFactoryData } from './node-manifest-whole-factory-data.ts';

export const HANDLER_REFERENCE_IDS = {
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
};

export const HANDLER_REFERENCE_FACTORIES: Readonly<
  Record<string, Omit<NodeManifestWholeFactoryData, 'canonical' | 'selectedOrdinal'>>
> = {
  handler: {
    version: 1,
    originalSha256: 'bd5a68e35a737edc1014cd47ff217aab57db732424ea1bb74a4e11b0d2ea9ba0',
    factory: {
      ids: [
        HANDLER_REFERENCE_IDS.routeKind,
        HANDLER_REFERENCE_IDS.hoist,
        HANDLER_REFERENCE_IDS.handler,
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
        id: HANDLER_REFERENCE_IDS.telemetryExternal,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 11_445,
            end: 11_453,
          },
        ],
      },
      {
        ordinal: 1,
        id: HANDLER_REFERENCE_IDS.telemetry,
        idType: 'number',
        occurrences: [
          {
            kind: 'require',
            start: 11_465,
            end: 11_474,
          },
        ],
      },
      {
        ordinal: 2,
        id: HANDLER_REFERENCE_IDS.escape,
        idType: 'number',
        occurrences: [
          {
            kind: 'import',
            start: 22_601,
            end: 22_610,
          },
        ],
      },
      {
        ordinal: 3,
        id: HANDLER_REFERENCE_IDS.stream,
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
        id: HANDLER_REFERENCE_IDS.path,
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
        id: HANDLER_REFERENCE_IDS.fresh,
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
        id: HANDLER_REFERENCE_IDS.noFallback,
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
    originalSha256: 'bd5a68e35a737edc1014cd47ff217aab57db732424ea1bb74a4e11b0d2ea9ba0',
    factory: {
      ids: [HANDLER_REFERENCE_IDS.noFallback],
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
    originalSha256: 'bd5a68e35a737edc1014cd47ff217aab57db732424ea1bb74a4e11b0d2ea9ba0',
    factory: {
      ids: [HANDLER_REFERENCE_IDS.fresh],
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
    originalSha256: '317721ef00dcdd38cad41c50fb628b087b22a6eea29d0b5e414725e553b971a3',
    factory: {
      ids: [HANDLER_REFERENCE_IDS.path],
      start: 44_125,
      end: 44_177,
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
    originalSha256: 'bd5a68e35a737edc1014cd47ff217aab57db732424ea1bb74a4e11b0d2ea9ba0',
    factory: {
      ids: [HANDLER_REFERENCE_IDS.stream],
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
    originalSha256: 'bd5a68e35a737edc1014cd47ff217aab57db732424ea1bb74a4e11b0d2ea9ba0',
    factory: {
      ids: [HANDLER_REFERENCE_IDS.escape],
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
    originalSha256: '317721ef00dcdd38cad41c50fb628b087b22a6eea29d0b5e414725e553b971a3',
    factory: {
      ids: [HANDLER_REFERENCE_IDS.telemetry],
      start: 44_183,
      end: 68_468,
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
    originalSha256: '317721ef00dcdd38cad41c50fb628b087b22a6eea29d0b5e414725e553b971a3',
    factory: {
      ids: [HANDLER_REFERENCE_IDS.telemetryExternal],
      start: 43_835,
      end: 43_953,
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
