import { Test } from '@nestjs/testing';

import { claudeAgentApiKey } from '../src/claude-agent/claude-agent.config';
import { ClaudeAgentModule } from '../src/claude-agent/claude-agent.module';
import { ClaudeAgentService } from '../src/claude-agent/claude-agent.service';

// This suite calls the real Anthropic API, so it needs network and the token in
// apps/api/.env, and it bills the account. Haiku keeps a run at a fraction of a
// cent. Skipping without a token rather than failing keeps a checkout that never
// configured one able to run the rest of the suite; jest prints the skip, so the
// gap stays visible.
const describeWithToken = claudeAgentApiKey ? describe : describe.skip;

describeWithToken('Claude Agent SDK', () => {
  let service: ClaudeAgentService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ClaudeAgentModule],
    }).compile();

    service = moduleRef.get(ClaudeAgentService);
  });

  it('runs on the model the service is configured with', () => {
    expect(service.model).toBe('claude-haiku-4-5');
  });

  // The assertion stays loose because a model answer is not deterministic: it
  // checks that a real answer came back, not that a given string did.
  it('answers a prompt through the Claude Agent SDK', async () => {
    const answer = await service.ask('Reply with exactly one word: pong');

    expect(answer.toLowerCase()).toContain('pong');
  }, 120_000);
});
