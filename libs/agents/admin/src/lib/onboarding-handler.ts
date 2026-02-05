/**
 * OnboardingHandler manages the user onboarding flow for timezone collection.
 */

import {
  FamilyAccessRepository,
  IdentityRepository,
  type DatabaseClient,
} from '@sobremesa/database';
import type { MessageSender, SupportedLanguage } from '@sobremesa/shared-types';
import { createLogger } from '@sobremesa/shared-utils';
import type pino from 'pino';
import {
  TIMEZONE_KEYBOARD,
  TIMEZONE_KEYBOARD_OTHER,
  formatOnboardingDm,
  formatTimezoneConfirmation,
  formatGroupReminder,
} from './onboarding-messages';

export interface OnboardingHandlerOptions {
  dbClient: DatabaseClient;
  messageSender: MessageSender;
  logger?: pino.Logger;
}

export interface SendOnboardingDmResult {
  success: boolean;
  error?: string;
  dmSent?: boolean;
  groupReminderSent?: boolean;
}

/**
 * Handler for user onboarding flow (timezone collection).
 */
export class OnboardingHandler {
  private familyAccessRepo: FamilyAccessRepository;
  private identityRepo: IdentityRepository;
  private messageSender: MessageSender;
  private logger: pino.Logger;

  constructor(options: OnboardingHandlerOptions) {
    this.familyAccessRepo = new FamilyAccessRepository(options.dbClient);
    this.identityRepo = new IdentityRepository(options.dbClient);
    this.messageSender = options.messageSender;
    this.logger = options.logger || createLogger({ name: 'onboarding' });
  }

  /**
   * Send onboarding DM to a user who just joined a family chat.
   * If DM fails (user hasn't started chat with bot), sends a group reminder.
   *
   * @param identityId - The identity ID of the user
   * @param familyId - The family ID
   * @param familyName - The family name for personalization
   * @param language - The family's primary language
   * @param groupChatId - The group chat ID for fallback reminder
   * @param userName - The user's display name for fallback reminder
   */
  async sendOnboardingDm(
    identityId: string,
    familyId: string,
    familyName: string,
    language: SupportedLanguage,
    groupChatId: string,
    userName: string,
  ): Promise<SendOnboardingDmResult> {
    this.logger.info({ identityId, familyId }, 'Sending onboarding DM');

    try {
      // Get the identity to find the Telegram user ID
      const identity = await this.identityRepo.findById(identityId);
      if (!identity) {
        return { success: false, error: 'Identity not found' };
      }

      // Only handle Telegram for now
      if (identity.provider !== 'telegram') {
        return { success: false, error: 'Provider not supported' };
      }

      // Skip if user already has timezone set
      if (identity.timezone) {
        this.logger.info(
          { identityId, timezone: identity.timezone },
          'User already has timezone, skipping onboarding',
        );
        await this.familyAccessRepo.updateOnboardingState(
          identityId,
          familyId,
          'completed',
        );
        return { success: true, dmSent: false };
      }

      // Build the onboarding message
      const dmMessage = formatOnboardingDm(language, familyName);

      // Try to send DM to the user
      try {
        await this.messageSender.sendMessage('admin', {
          chatId: identity.providerUserId, // Telegram user ID for DM
          text: dmMessage,
          replyMarkup: TIMEZONE_KEYBOARD,
        });

        // Update onboarding state to dm_sent
        await this.familyAccessRepo.updateOnboardingState(
          identityId,
          familyId,
          'dm_sent',
        );

        this.logger.info(
          { identityId, familyId },
          'Onboarding DM sent successfully',
        );

        return { success: true, dmSent: true };
      } catch (dmError) {
        // DM failed - user probably hasn't started chat with bot
        this.logger.warn(
          { identityId, error: dmError },
          'Failed to send onboarding DM, sending group reminder',
        );

        // Send reminder in group chat
        const reminderMessage = formatGroupReminder(language, userName);

        await this.messageSender.sendMessage('admin', {
          chatId: groupChatId,
          text: reminderMessage,
        });

        // Keep state as not_started so we can retry later
        return {
          success: true,
          dmSent: false,
          groupReminderSent: true,
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        { identityId, familyId, error: errorMessage },
        'Onboarding failed',
      );
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Handle timezone callback from inline keyboard button press.
   *
   * @param identityId - The identity ID of the user
   * @param timezone - The selected timezone (IANA format)
   * @param language - Language for confirmation message
   * @returns The confirmation message to send
   */
  async handleTimezoneSelection(
    identityId: string,
    timezone: string,
    language: SupportedLanguage,
  ): Promise<{
    success: boolean;
    confirmationMessage?: string;
    error?: string;
  }> {
    this.logger.info({ identityId, timezone }, 'Handling timezone selection');

    try {
      // Update identity with timezone
      const updated = await this.identityRepo.updateTimezone(
        identityId,
        timezone,
      );
      if (!updated) {
        return { success: false, error: 'Failed to update timezone' };
      }

      // Mark all pending onboarding flows as completed for this identity
      // (user may be in multiple families)
      const familyAccesses =
        await this.findPendingOnboardingForIdentity(identityId);
      for (const access of familyAccesses) {
        await this.familyAccessRepo.updateOnboardingState(
          identityId,
          access.familyId,
          'completed',
        );
      }

      const confirmationMessage = formatTimezoneConfirmation(
        language,
        timezone,
      );

      this.logger.info(
        { identityId, timezone, familiesUpdated: familyAccesses.length },
        'Timezone saved successfully',
      );

      return { success: true, confirmationMessage };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        { identityId, timezone, error: errorMessage },
        'Failed to handle timezone selection',
      );
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Get the "other timezones" keyboard for users who need more options.
   */
  getOtherTimezonesKeyboard(): typeof TIMEZONE_KEYBOARD_OTHER {
    return TIMEZONE_KEYBOARD_OTHER;
  }

  /**
   * Get the main timezone keyboard.
   */
  getTimezoneKeyboard(): typeof TIMEZONE_KEYBOARD {
    return TIMEZONE_KEYBOARD;
  }

  /**
   * Find all family access records with pending onboarding for an identity.
   * (Private helper)
   */
  private async findPendingOnboardingForIdentity(
    identityId: string,
  ): Promise<Array<{ familyId: string }>> {
    // Query family_access for all dm_sent states for this identity
    const { data, error } = await (
      this.familyAccessRepo as unknown as { client: DatabaseClient }
    ).client
      .from('family_access')
      .select('family_id')
      .eq('identity_id', identityId)
      .eq('onboarding_state', 'dm_sent');

    if (error || !data) {
      return [];
    }

    return data.map((row: { family_id: string }) => ({
      familyId: row.family_id,
    }));
  }
}
