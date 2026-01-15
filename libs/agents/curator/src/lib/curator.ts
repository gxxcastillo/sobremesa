import { ImageRepository } from '@sobremesa/database';
import { loadPrompt } from '@sobremesa/prompts';
import { createLogger } from '@sobremesa/shared-utils';
import type pino from 'pino';

/**
 * Anthropic client interface.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnthropicClient = any;

/**
 * Configuration for the Curator vision service.
 */
export interface CuratorConfig {
  /** Model to use for image analysis */
  model: string;
  /** Maximum tokens for response */
  maxTokens: number;
}

export const DEFAULT_CURATOR_CONFIG: CuratorConfig = {
  model: 'claude-3-5-haiku-20241022',
  maxTokens: 1024,
};

/**
 * Result of image analysis.
 */
export interface ImageAnalysis {
  /** Brief description of what's in the image */
  description: string;
  /** Number of people visible (null if uncertain) */
  peopleCount?: number;
  /** Estimated era/decade (e.g., "1960s", "early 1900s") */
  estimatedEra?: string;
  /** Any visible text extracted from the image */
  visibleText: string[];
  /** Type of image: photo, document, handwritten, etc. */
  imageType?: string;
  /** Setting/location hints from visual context */
  settingHints?: string;
}

/**
 * Options for creating a Curator.
 */
export interface CuratorOptions {
  /** Anthropic client (from @anthropic-ai/sdk) */
  anthropic: AnthropicClient;
  /** Image repository */
  imageRepo?: ImageRepository;
  /** Logger instance */
  logger?: pino.Logger;
  /** Configuration overrides */
  config?: Partial<CuratorConfig>;
}

/**
 * The Curator is a vision service that analyzes images and stores visual metadata.
 * It does NOT extract entities or generate questions - that's Scribe's job.
 * Curator provides visual context that Scribe can use when processing related text messages.
 */
export class Curator {
  private anthropic: AnthropicClient;
  private imageRepo: ImageRepository;
  private logger: pino.Logger;
  private config: CuratorConfig;

  constructor(options: CuratorOptions) {
    this.anthropic = options.anthropic;
    this.imageRepo = options.imageRepo || new ImageRepository();
    this.logger = options.logger || createLogger({ name: 'curator' });
    this.config = { ...DEFAULT_CURATOR_CONFIG, ...options.config };
  }

  /**
   * Analyze an image and update the Image record with visual metadata.
   * This runs async and doesn't block message processing.
   */
  async analyze(
    familyId: string,
    imageId: string,
    imageData: Buffer,
  ): Promise<ImageAnalysis> {
    this.logger.info({ familyId, imageId }, 'Curator analyzing image');

    const image = await this.imageRepo.findById(familyId, imageId);
    if (!image) {
      throw new Error(`Image not found: ${imageId}`);
    }

    if (image.analyzed) {
      this.logger.debug({ imageId }, 'Image already analyzed, skipping');
      return this.getExistingAnalysis(image);
    }

    const startTime = Date.now();

    try {
      const base64Image = imageData.toString('base64');
      const mimeType = this.getMimeType(image.fileType);

      const response = await this.anthropic.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: loadPrompt('curator'),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType,
                  data: base64Image,
                },
              },
              {
                type: 'text',
                text: 'Analyze this image.',
              },
            ],
          },
        ],
      });

      const duration = Date.now() - startTime;
      this.logger.info({ imageId, duration }, 'Vision API response received');

      // Extract text content
      const textContent = response.content.find(
        (c: { type: string; text?: string }) => c.type === 'text',
      );
      if (!textContent || textContent.type !== 'text' || !textContent.text) {
        throw new Error('No text content in Claude response');
      }

      // Parse the analysis
      const analysis = this.parseAnalysis(textContent.text);

      // Update the Image record
      await this.imageRepo.markAnalyzed(familyId, imageId, {
        description: analysis.description,
        peopleCount: analysis.peopleCount,
        estimatedEra: analysis.estimatedEra,
        visibleText: analysis.visibleText,
      });

      this.logger.info(
        {
          imageId,
          peopleCount: analysis.peopleCount,
          estimatedEra: analysis.estimatedEra,
          hasVisibleText: analysis.visibleText.length > 0,
        },
        'Image analysis complete',
      );

      return analysis;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error({ imageId, error, duration }, 'Image analysis failed');
      throw error;
    }
  }

  /**
   * Analyze an image without the actual image data (metadata-only analysis).
   * Used when we can't fetch the image but want to create a placeholder analysis.
   */
  async analyzeMetadataOnly(
    familyId: string,
    imageId: string,
  ): Promise<ImageAnalysis> {
    this.logger.info({ familyId, imageId }, 'Curator analyzing metadata only');

    const image = await this.imageRepo.findById(familyId, imageId);
    if (!image) {
      throw new Error(`Image not found: ${imageId}`);
    }

    // Create a minimal analysis based on available metadata
    const analysis: ImageAnalysis = {
      description: `${image.fileType || 'media'} shared by ${
        image.sharedBy || 'unknown'
      }`,
      visibleText: [],
      imageType: image.fileType === 'document' ? 'document' : 'photo',
    };

    // Mark as analyzed with minimal info
    await this.imageRepo.markAnalyzed(familyId, imageId, {
      description: analysis.description,
    });

    return analysis;
  }

  /**
   * Get a formatted context string for an image, suitable for Scribe's context.
   */
  formatForScribeContext(image: {
    id: string;
    fileType?: string;
    analyzed: boolean;
    analysis?: Record<string, unknown>;
    peopleCount?: number;
    estimatedEra?: string;
    visibleText?: string[];
    sharedBy?: string;
    createdAt: Date;
  }): string {
    const parts: string[] = [];

    if (!image.analyzed) {
      parts.push(
        `[${image.id.slice(0, 8)}] ${
          image.fileType || 'image'
        } (not yet analyzed)`,
      );
    } else {
      const desc =
        ((image.analysis as Record<string, unknown>)?.description as string) ||
        `${image.fileType || 'image'}`;
      parts.push(`[${image.id.slice(0, 8)}] ${desc}`);

      if (image.peopleCount) {
        parts.push(`${image.peopleCount} people`);
      }
      if (image.estimatedEra) {
        parts.push(`~${image.estimatedEra}`);
      }
      if (image.visibleText && image.visibleText.length > 0) {
        parts.push(`text: "${image.visibleText.slice(0, 2).join(', ')}"`);
      }
    }

    if (image.sharedBy) {
      parts.push(`shared by ${image.sharedBy}`);
    }

    return parts.join(' | ');
  }

  /**
   * Parse the JSON analysis from Claude's response.
   */
  private parseAnalysis(text: string): ImageAnalysis {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return this.createFallbackAnalysis(text);
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        description: parsed.description || 'No description available',
        peopleCount:
          typeof parsed.people_count === 'number'
            ? parsed.people_count
            : undefined,
        estimatedEra: parsed.estimated_era || undefined,
        visibleText: Array.isArray(parsed.visible_text)
          ? parsed.visible_text
          : [],
        imageType: parsed.image_type || undefined,
        settingHints: parsed.setting_hints || undefined,
      };
    } catch (error) {
      this.logger.warn({ error }, 'Failed to parse analysis JSON');
      return this.createFallbackAnalysis(text);
    }
  }

  /**
   * Create a fallback analysis when JSON parsing fails.
   */
  private createFallbackAnalysis(rawText: string): ImageAnalysis {
    return {
      description: rawText.slice(0, 200),
      visibleText: [],
    };
  }

  /**
   * Extract analysis from an already-analyzed Image record.
   */
  private getExistingAnalysis(image: {
    analysis?: Record<string, unknown>;
    peopleCount?: number;
    estimatedEra?: string;
    visibleText?: string[];
  }): ImageAnalysis {
    const analysis = image.analysis || {};
    return {
      description: (analysis.description as string) || 'Previously analyzed',
      peopleCount: image.peopleCount,
      estimatedEra: image.estimatedEra,
      visibleText: image.visibleText || [],
      imageType: analysis.image_type as string | undefined,
      settingHints: analysis.setting_hints as string | undefined,
    };
  }

  /**
   * Get MIME type for file type.
   */
  private getMimeType(fileType?: string): string {
    switch (fileType) {
      case 'photo':
        return 'image/jpeg';
      case 'document':
        return 'image/png'; // Documents sent as images
      case 'video':
        return 'video/mp4';
      default:
        return 'image/jpeg';
    }
  }
}
