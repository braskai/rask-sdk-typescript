export const LANG: string;
export function controlClient(control: string): {
  // biome-ignore lint/suspicious/noExplicitAny: the control API answers plain JSON, shaped per endpoint.
  get(path: string): Promise<any>;
  // biome-ignore lint/suspicious/noExplicitAny: the control API answers plain JSON, shaped per endpoint.
  post(path: string, body?: unknown): Promise<any>;
};
export function runScenario(
  control: ReturnType<typeof controlClient>,
  id: string,
  sdk: unknown,
): Promise<{ id: string; pass: boolean; failures: unknown[]; requests: number }>;
export function scenarioIds(control: ReturnType<typeof controlClient>, options?: { slow?: boolean }): Promise<string[]>;
