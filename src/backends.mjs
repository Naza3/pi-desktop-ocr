import { NexaClient } from './nexa-client.mjs';
import { OpenAIClient } from './openai-client.mjs';

export function createClient(options) {
  return options.backend === 'nexa' ? new NexaClient(options) : new OpenAIClient(options);
}
