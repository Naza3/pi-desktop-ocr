import { NexaClient } from './nexa-client.ts';
import { OpenAIClient } from './openai-client.ts';
import type { BackendClient, ClientOptions } from '../shared/contracts.ts';

export function createClient(options: ClientOptions): BackendClient {
  return options.backend === 'nexa' ? new NexaClient(options) : new OpenAIClient(options);
}
