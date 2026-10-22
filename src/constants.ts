/** Production Rask API base URL. */
export const DEFAULT_BASE_URL = 'https://api.rask.ai';

/** OAuth2 token endpoint (AWS Cognito) used for the client credentials grant. */
export const DEFAULT_TOKEN_URL = 'https://rask-prod.auth.us-east-2.amazoncognito.com/oauth2/token';

/** OAuth2 scopes requested by default; together they cover every public API operation. */
export const DEFAULT_SCOPES: readonly string[] = Object.freeze([
  'api/source',
  'api/input',
  'api/output',
  'api/limit',
]);
