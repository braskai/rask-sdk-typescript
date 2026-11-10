// Renders src/generated/resources.gen.ts from the contract: one class per tag, one method per operationId. The generated
// low-level functions build the requests; these methods add the behaviour of src/transport.ts and carry the docs.
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const camel = (text) =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word, index) => (index === 0 ? word.toLowerCase() : word[0].toUpperCase() + word.slice(1)))
    .join('');
const upperFirst = (name) => name[0].toUpperCase() + name.slice(1);
const pascal = (text) => upperFirst(camel(text));

const deref = (spec, node) => {
  let current = node;
  while (current?.$ref) {
    current = current.$ref
      .slice(2)
      .split('/')
      .reduce((value, key) => value[key], spec);
  }
  return current;
};

export function collectOperations(spec) {
  const operations = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])].map((p) => deref(spec, p));
      const header = (name) => parameters.find((p) => p.in === 'header' && p.name === name);
      const rule = (p) => (p ? (p.required ? 'required' : 'optional') : 'none');
      const success = Object.entries(operation.responses).find(([code]) => code.startsWith('2'))[1];
      const schema = deref(spec, deref(spec, success).content?.['application/json']?.schema);
      const paged = parameters.some((p) => p.in === 'query' && p.name === 'cursor');
      if (paged && !(schema?.properties?.data && schema?.properties?.next_cursor)) {
        throw new Error(`${operation.operationId} takes a cursor but does not answer with the list envelope.`);
      }
      const requestBody = deref(spec, operation.requestBody);
      operations.push({
        id: operation.operationId,
        tag: operation.tags?.[0] ?? 'Default',
        method: method.toUpperCase(),
        path,
        summary: operation.summary,
        description: operation.description,
        deprecated: operation.deprecated === true,
        pathParams: parameters.filter((p) => p.in === 'path').map((p) => p.name),
        idempotencyKey: rule(header('Idempotency-Key')),
        ifMatch: rule(header('If-Match')),
        ifNoneMatch: header('If-None-Match') !== undefined,
        paged,
        argumentsRequired:
          parameters.some((p) => p.required && (p.in === 'path' || p.in === 'query')) ||
          requestBody?.required === true ||
          header('If-Match')?.required === true,
      });
    }
  }
  return operations;
}

const doc = (operation) => {
  const lines = [operation.summary, '', ...(operation.description ?? '').split('\n')];
  if (operation.deprecated) lines.push('', '@deprecated This operation is deprecated by the API.');
  const body = lines.map((line) => `   * ${line.replaceAll('*/', '*\\/')}`.trimEnd()).join('\n');
  return `  /**\n${body}\n   */`;
};

const paramsType = (operation) => {
  const parts = [`Params<T.${upperFirst(operation.id)}Data>`];
  if (operation.idempotencyKey !== 'none') parts.push('WithIdempotencyKey');
  if (operation.ifMatch === 'required') parts.push('WithIfMatch');
  if (operation.ifMatch === 'optional') parts.push('WithOptionalIfMatch');
  if (operation.ifNoneMatch) parts.push('WithIfNoneMatch');
  return parts.join(' & ');
};

const renderMethod = (operation) => {
  const { id } = operation;
  const type = paramsType(operation);
  const optional = operation.argumentsRequired ? '' : '?';
  const response = `T.${upperFirst(id)}Response`;
  const call = `OPERATIONS.${id}, sdk.${id}, params`;
  if (operation.paged) {
    return `${doc(operation)}
  ${id}(params${optional}: ${type}): PagePromise<${response}> {
    return this.transport.list(${call});
  }`;
  }
  if (operation.ifNoneMatch) {
    return `${doc(operation)}
  ${id}(params: ${type} & { ifNoneMatch: string }): Promise<RaskResponse<${response} | undefined>>;
${doc(operation)}
  ${id}(params${optional}: ${type}): Promise<RaskResponse<${response}>>;
  ${id}(params${optional}: ${type}): Promise<RaskResponse<${response} | undefined>> {
    return this.transport.call(${call});
  }`;
  }
  return `${doc(operation)}
  ${id}(params${optional}: ${type}): Promise<RaskResponse<${response}>> {
    return this.transport.call(${call});
  }`;
};

export function renderResources(spec) {
  const operations = collectOperations(spec);
  const groups = new Map();
  for (const operation of operations) {
    if (!groups.has(operation.tag)) groups.set(operation.tag, []);
    groups.get(operation.tag).push(operation);
  }
  const sortedTags = [...groups.keys()].sort();
  const meta = [...operations]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (o) =>
        `  ${o.id}: { id: '${o.id}', group: '${camel(o.tag)}', method: '${o.method}', path: '${o.path}', ` +
        `pathParams: ${JSON.stringify(o.pathParams)}, idempotencyKey: '${o.idempotencyKey}', ifMatch: '${o.ifMatch}', ` +
        `ifNoneMatch: ${o.ifNoneMatch}, paged: ${o.paged}, deprecated: ${o.deprecated} },`,
    )
    .join('\n');
  const classes = sortedTags
    .map((tag) => {
      const methods = groups.get(tag).map(renderMethod).join('\n\n');
      return `/** Operations of the contract's "${tag}" tag. */\nexport class ${pascal(tag)}Resource extends Resource {\n${methods}\n}`;
    })
    .join('\n\n');
  const fields = sortedTags.map((tag) => `  readonly ${camel(tag)}: ${pascal(tag)}Resource;`).join('\n');
  const assignments = sortedTags
    .map((tag) => `    this.${camel(tag)} = new ${pascal(tag)}Resource(transport);`)
    .join('\n');
  return `// Generated by scripts/generate-resources.mjs from the contract. Do not edit.
import type { PagePromise } from '../pagination';
import {
  type Params,
  Resource,
  type WithIdempotencyKey,
  type WithIfMatch,
  type WithIfNoneMatch,
  type WithOptionalIfMatch,
} from '../resource';
import type { OperationMeta, RaskResponse, Transport } from '../transport';
import * as sdk from './sdk.gen';
import type * as T from './types.gen';

export interface GeneratedOperation extends OperationMeta {
  /** The property of the client that holds this operation's method. */
  readonly group: string;
  readonly paged: boolean;
  readonly deprecated: boolean;
}

/** Every operation of the contract. */
export const OPERATIONS = {
${meta}
} as const satisfies Record<string, GeneratedOperation>;

${classes}

/** One property per resource. */
export class RaskResources {
${fields}

  constructor(transport: Transport) {
${assignments}
  }
}
`;
}
