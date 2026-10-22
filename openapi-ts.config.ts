import { defineConfig } from '@hey-api/openapi-ts';

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Inline `$ref` request bodies (and single-member `allOf` wrappers around them)
 * so that the generated SDK methods take the body fields as flat named
 * parameters, e.g. `createProject({ video_id, dst_lang })` instead of
 * `createProject({ projectCreate: { video_id, dst_lang } })`.
 *
 * Only the in-memory copy is patched; `openapi/openapi.yml` stays untouched and
 * the component schemas are still emitted as named types.
 */
const inlineRequestBodies = (spec: unknown): void => {
  if (!isObject(spec) || !isObject(spec.paths)) return;
  const components = isObject(spec.components) ? spec.components : {};
  const schemas = isObject(components.schemas) ? components.schemas : {};

  for (const pathItem of Object.values(spec.paths)) {
    if (!isObject(pathItem)) continue;
    for (const operation of Object.values(pathItem)) {
      if (!isObject(operation) || !isObject(operation.requestBody)) continue;
      const content = operation.requestBody.content;
      if (!isObject(content)) continue;

      for (const media of Object.values(content)) {
        if (!isObject(media) || !isObject(media.schema)) continue;
        let schema: JsonObject = media.schema;
        const allOf = schema.allOf;
        if (Array.isArray(allOf) && allOf.length === 1 && isObject(allOf[0])) {
          schema = allOf[0];
        }
        const ref = schema.$ref;
        if (typeof ref !== 'string' || !ref.startsWith('#/components/schemas/')) continue;
        const target = schemas[ref.slice('#/components/schemas/'.length)];
        if (!isObject(target) || target.type !== 'object') continue;
        media.schema = structuredClone(target);
      }
    }
  }
};

export default defineConfig({
  input: './openapi/openapi.yml',
  output: {
    path: './src/generated',
    clean: true,
  },
  parser: {
    patch: {
      input: inlineRequestBodies,
    },
  },
  plugins: [
    {
      name: '@hey-api/client-fetch',
      throwOnError: true,
    },
    {
      name: '@hey-api/typescript',
      // Emit enums as `as const` objects too, e.g. `ProjectStatus.MERGING_DONE`.
      enums: 'javascript',
    },
    {
      name: '@hey-api/sdk',
      // One instantiable class whose method names are the spec's operationIds.
      operations: {
        strategy: 'single',
        containerName: 'RaskApi',
        methods: 'instance',
        nesting: 'operationId',
      },
      // Methods resolve to the parsed response body and throw on non-2xx.
      responseStyle: 'data',
      // Path, query and body fields are passed as one flat object.
      paramsStructure: 'flat',
    },
  ],
});
