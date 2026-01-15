/**
 * Language-aware messages for the Admin agent.
 */

import {
  type SupportedLanguage,
  LANGUAGE_LOCALES,
  isSupportedLanguage,
  DEFAULT_LANGUAGE,
} from '@sobremesa/shared-types';

export interface AdminMessages {
  help: {
    greeting: string;
    description: string;
    commands: string;
    commandSobremesa: string;
    commandStatus: string;
    outro: string;
  };
  mention: {
    greeting: (familyName: string) => string;
    capabilities: string;
    shareMemories: string;
    sharePhotos: string;
    checkStatus: string;
    outro: string;
  };
  status: {
    title: (familyName: string) => string;
    messagesArchived: (count: number) => string;
    membersActive: (count: number) => string;
    activeSince: (date: string) => string;
    encouragement: string;
  };
}

const MESSAGES_EN: AdminMessages = {
  help: {
    greeting: "Hi! I'm the Sobremesa family history bot.",
    description:
      'Add me to your family group chat and use /sobremesa to start preserving your family stories.',
    commands: 'Commands:',
    commandSobremesa:
      '• /sobremesa - Set up family archive (in new group) or show status (in registered group)',
    commandStatus: '• /status - Show family archive status',
    outro:
      "Just chat naturally in your family group - I'll listen and preserve the important stories!",
  },
  mention: {
    greeting: (familyName) =>
      `Hi! I'm here to help preserve ${familyName}'s stories.`,
    capabilities: 'You can:',
    shareMemories: '• Share family memories and stories in this chat',
    sharePhotos: "• Share old photos and I'll help identify people",
    checkStatus: "• Use /status to see what we've collected",
    outro: "Just chat naturally - I'm listening!",
  },
  status: {
    title: (familyName) => `Family Archive: ${familyName}`,
    messagesArchived: (count) => `Messages archived: ${count}`,
    membersActive: (count) => `Family members seen: ${count}`,
    activeSince: (date) => `Active since: ${date}`,
    encouragement: 'Keep sharing your family stories!',
  },
};

const MESSAGES_ES: AdminMessages = {
  help: {
    greeting: '¡Hola! Soy el bot de historia familiar Sobremesa.',
    description:
      'Agrégame a tu grupo familiar y usa /sobremesa para comenzar a preservar las historias de tu familia.',
    commands: 'Comandos:',
    commandSobremesa:
      '• /sobremesa - Configurar el archivo familiar (en grupo nuevo) o ver estado (en grupo registrado)',
    commandStatus: '• /status - Ver el estado del archivo familiar',
    outro:
      'Simplemente conversen naturalmente en su grupo familiar - ¡escucharé y preservaré las historias importantes!',
  },
  mention: {
    greeting: (familyName) =>
      `¡Hola! Estoy aquí para ayudar a preservar las historias de ${familyName}.`,
    capabilities: 'Pueden:',
    shareMemories: '• Compartir memorias e historias familiares en este chat',
    sharePhotos: '• Compartir fotos antiguas y ayudaré a identificar personas',
    checkStatus: '• Usar /status para ver lo que hemos recolectado',
    outro: '¡Solo conversen naturalmente - estoy escuchando!',
  },
  status: {
    title: (familyName) => `Archivo Familiar: ${familyName}`,
    messagesArchived: (count) => `Mensajes archivados: ${count}`,
    membersActive: (count) => `Miembros de la familia vistos: ${count}`,
    activeSince: (date) => `Activo desde: ${date}`,
    encouragement: '¡Sigan compartiendo sus historias familiares!',
  },
};

const MESSAGES: Record<SupportedLanguage, AdminMessages> = {
  en: MESSAGES_EN,
  es: MESSAGES_ES,
};

/**
 * Get messages for a specific language.
 * Falls back to English if language is not supported.
 */
export function getMessages(language: SupportedLanguage): AdminMessages {
  return MESSAGES[language];
}

/**
 * Normalize a language string to a SupportedLanguage.
 * Falls back to default language if not supported.
 */
export function normalizeLanguage(language: string): SupportedLanguage {
  return isSupportedLanguage(language) ? language : DEFAULT_LANGUAGE;
}

/**
 * Format the help message for DMs.
 */
export function formatHelpMessage(language: SupportedLanguage): string {
  const m = getMessages(language).help;
  return [
    m.greeting,
    '',
    m.description,
    '',
    m.commands,
    m.commandSobremesa,
    m.commandStatus,
    '',
    m.outro,
  ].join('\n');
}

/**
 * Format the mention response message.
 */
export function formatMentionMessage(
  language: SupportedLanguage,
  familyName: string
): string {
  const m = getMessages(language).mention;
  return [
    m.greeting(familyName),
    '',
    m.capabilities,
    m.shareMemories,
    m.sharePhotos,
    m.checkStatus,
    '',
    m.outro,
  ].join('\n');
}

/**
 * Format the status message.
 */
export function formatStatusMessage(
  language: SupportedLanguage,
  familyName: string,
  stats: { eventCount: number; memberCount: number },
  createdAt?: Date
): string {
  const m = getMessages(language).status;
  const lines: string[] = [
    m.title(familyName),
    '',
    m.messagesArchived(stats.eventCount),
    m.membersActive(stats.memberCount),
  ];

  if (createdAt) {
    const createdDate = createdAt.toLocaleDateString(
      LANGUAGE_LOCALES[language]
    );
    lines.push(m.activeSince(createdDate));
  }

  lines.push('', m.encouragement);

  return lines.join('\n');
}
