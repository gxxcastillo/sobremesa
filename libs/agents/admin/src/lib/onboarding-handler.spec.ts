import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageDeliveryError } from '@sobremesa/shared-types';
import { OnboardingHandler } from './onboarding-handler';

const IDENTITY_ID = 'identity-1';
const FAMILY_ID = 'fam-1';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createChainableMock(finalResult: { data: any; error: any }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(finalResult);
  return chain;
}

describe('OnboardingHandler.sendOnboardingDm -- outbound-send-reliability-plan.md #3', () => {
  let mockMessageSender: { sendMessage: ReturnType<typeof vi.fn> };
  let mockDbClient: { from: ReturnType<typeof vi.fn> };
  let handler: OnboardingHandler;

  const baseIdentityRow = {
    id: IDENTITY_ID,
    provider: 'telegram',
    provider_user_id: 'tg-user-1',
    timezone: null,
  };

  beforeEach(() => {
    mockMessageSender = {
      sendMessage: vi.fn().mockResolvedValue({ status: 'sent', messageId: 1 }),
    };
    mockDbClient = { from: vi.fn() };
    mockDbClient.from.mockImplementation((table: string) => {
      if (table === 'identities') {
        return createChainableMock({ data: baseIdentityRow, error: null });
      }
      if (table === 'family_access') {
        return createChainableMock({ data: { id: 'fa-1' }, error: null });
      }
      throw new Error(`unexpected table: ${table}`);
    });

    handler = new OnboardingHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dbClient: mockDbClient as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messageSender: mockMessageSender as any,
    });
  });

  const send = () =>
    handler.sendOnboardingDm(
      IDENTITY_ID,
      FAMILY_ID,
      'The Smiths',
      'en',
      'group-1',
      'Alice',
    );

  it('claims a dedup key scoped to identity+family for the DM', async () => {
    const result = await send();

    expect(result).toEqual({ success: true, dmSent: true });
    const [, , options] = mockMessageSender.sendMessage.mock.calls[0];
    expect(options.dedup).toEqual({
      familyId: FAMILY_ID,
      key: `admin:onboarding:${IDENTITY_ID}:${FAMILY_ID}`,
    });
  });

  it('falls back to a group reminder, with its own dedup key, only on a definitive MessageDeliveryError', async () => {
    mockMessageSender.sendMessage
      .mockRejectedValueOnce(new MessageDeliveryError('blocked by user'))
      .mockResolvedValueOnce({ status: 'sent', messageId: 2 });

    const result = await send();

    expect(result).toEqual({
      success: true,
      dmSent: false,
      groupReminderSent: true,
    });
    expect(mockMessageSender.sendMessage).toHaveBeenCalledTimes(2);
    const [, , reminderOptions] = mockMessageSender.sendMessage.mock.calls[1];
    expect(reminderOptions.dedup).toEqual({
      familyId: FAMILY_ID,
      key: `admin:onboarding-reminder:${IDENTITY_ID}:${FAMILY_ID}`,
    });
  });

  it('does not fall back to a group reminder on an ambiguous ("unconfirmed") DM outcome -- never resend/duplicate into an already-maybe-delivered DM', async () => {
    mockMessageSender.sendMessage.mockResolvedValueOnce({
      status: 'unconfirmed',
    });

    const result = await send();

    expect(result).toEqual({ success: true, dmSent: true });
    expect(mockMessageSender.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('propagates an unexpected non-delivery error instead of masking it as a DM failure', async () => {
    mockMessageSender.sendMessage.mockRejectedValueOnce(new Error('boom'));

    const result = await send();

    expect(result).toEqual({ success: false, error: 'boom' });
    expect(mockMessageSender.sendMessage).toHaveBeenCalledTimes(1);
  });
});
