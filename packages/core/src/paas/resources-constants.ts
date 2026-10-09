/**
 * The text binding carrying a deployment's resource manifest. Kept separate from resource
 * publication so build-time schemas can reserve its name without loading the runtime graph.
 */
export const RESOURCES_MANIFEST_BINDING = 'ARKOR_RESOURCES';
