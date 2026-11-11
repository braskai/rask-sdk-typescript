export function findHarness(): string;
export function guardFetch(): void;
export function startHarness(extra?: string[]): Promise<{
  baseUrl: string;
  control: string;
  otherUrl: string;
  apiKey: string;
  stop(): void;
}>;
