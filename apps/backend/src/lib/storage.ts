import https from 'https';
import http from 'http';
import { v2 as cloudinary, type UploadApiOptions, type UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';

import { config } from '../config';
import type { TransformOptions, UploadOptions, UploadResult } from '@snaptrace/types';

// Configure Cloudinary
cloudinary.config({
  cloud_name: config.cloudinary.cloudName,
  api_key: config.cloudinary.apiKey,
  api_secret: config.cloudinary.apiSecret,
  secure: true,
});

// ============================================================
// Storage Provider Interface
// ============================================================

export interface StorageProvider {
  upload(file: Buffer, options: UploadOptions): Promise<UploadResult>;
  delete(publicId: string): Promise<void>;
  getUrl(publicId: string, options?: TransformOptions): string;
}

// ============================================================
// Cloudinary Implementation
// ============================================================

export class CloudinaryStorage implements StorageProvider {
  async upload(file: Buffer, options: UploadOptions): Promise<UploadResult> {
    return new Promise((resolve, reject) => {
      const uploadOptions: UploadApiOptions = {
        folder: options.folder ?? 'jam/uploads',
        public_id: options.publicId,
        resource_type: options.resourceType ?? 'auto',
        tags: options.tags,
        overwrite: false,
        unique_filename: !options.publicId,
      };

      if (options.metadata) {
        uploadOptions.context = Object.entries(options.metadata)
          .map(([k, v]) => `${k}=${v}`)
          .join('|');
      }

      const uploadStream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
        if (error) {
          reject(new Error(`Cloudinary upload failed: ${error.message}`));
          return;
        }
        if (!result) {
          reject(new Error('Cloudinary upload returned no result'));
          return;
        }
        resolve(this.mapUploadResult(result));
      });

      const readable = new Readable();
      readable.push(file);
      readable.push(null);
      readable.pipe(uploadStream);
    });
  }

  async delete(publicId: string): Promise<void> {
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: 'video' });
    } catch {
      // Try image resource type if video fails
      try {
        await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
      } catch (err) {
        throw new Error(`Failed to delete asset ${publicId}: ${String(err)}`);
      }
    }
  }

  getUrl(publicId: string, options?: TransformOptions): string {
    const transformations: Record<string, string | number> = {};

    if (options?.width) {
      transformations['width'] = options.width;
    }
    if (options?.height) {
      transformations['height'] = options.height;
    }
    if (options?.quality) {
      transformations['quality'] = options.quality;
    }
    if (options?.format) {
      transformations['fetch_format'] = options.format;
    }
    if (options?.crop) {
      transformations['crop'] = options.crop;
    }

    return cloudinary.url(publicId, {
      secure: true,
      transformation: Object.keys(transformations).length > 0 ? [transformations] : undefined,
    });
  }

  async uploadUrl(url: string, options: UploadOptions): Promise<UploadResult> {
    const uploadOptions: UploadApiOptions = {
      folder: options.folder ?? 'jam/uploads',
      public_id: options.publicId,
      resource_type: options.resourceType ?? 'auto',
      tags: options.tags,
    };

    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const finalBuffer = Buffer.from(arrayBuffer);
    const recordingId = options.publicId ?? `rec_${Date.now()}`;

    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'video',
          folder: 'snaptrace/recordings',
          public_id: recordingId,
          overwrite: true,
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result!);
        },
      );

      uploadStream.end(finalBuffer);
    });

    return this.mapUploadResult(result);
  }

  private mapUploadResult(result: UploadApiResponse): UploadResult {
    return {
      publicId: result.public_id,
      url: result.url,
      secureUrl: result.secure_url,
      size: result.bytes,
      format: result.format,
      duration: result.duration,
      width: result.width,
      height: result.height,
    };
  }
}

// ============================================================
// Local Storage (for dev/testing without Cloudinary)
// ============================================================

export class LocalStorage implements StorageProvider {
  private readonly baseUrl: string;

  constructor(baseUrl = 'http://localhost:4000/uploads') {
    this.baseUrl = baseUrl;
  }

  async upload(file: Buffer, options: UploadOptions): Promise<UploadResult> {
    // In a real implementation, this would save to disk
    // For now, just return a mock result
    const publicId = options.publicId ?? `local_${Date.now()}`;
    return {
      publicId,
      url: `${this.baseUrl}/${publicId}`,
      secureUrl: `${this.baseUrl}/${publicId}`,
      size: file.length,
      format: 'mp4',
    };
  }

  async delete(_publicId: string): Promise<void> {
    // Would delete from disk
  }

  getUrl(publicId: string, _options?: TransformOptions): string {
    return `${this.baseUrl}/${publicId}`;
  }
}

// Export singleton storage instance
export const storage: StorageProvider = config.server.isTest
  ? new LocalStorage()
  : new CloudinaryStorage();

export default storage;
