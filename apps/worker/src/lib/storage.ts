import { v2 as cloudinary } from 'cloudinary';
import type { UploadApiResponse, UploadApiOptions } from 'cloudinary';
import { createReadStream } from 'fs';
import { logger } from '../utils/logger';

// Initialize Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

export interface StorageUploadOptions {
  folder?: string;
  publicId?: string;
  resourceType?: 'image' | 'video' | 'raw' | 'auto';
  tags?: string[];
  metadata?: Record<string, string>;
  overwrite?: boolean;
}

export interface StorageUploadResult {
  publicId: string;
  url: string;
  secureUrl: string;
  size: number;
  format: string;
  duration?: number;
  width?: number;
  height?: number;
}

/** Upload a file from local path to Cloudinary */
export async function uploadFile(
  filePath: string,
  options: StorageUploadOptions = {},
): Promise<StorageUploadResult> {
  const uploadOptions: UploadApiOptions = {
    folder: options.folder ?? 'jam-recordings',
    public_id: options.publicId,
    resource_type: options.resourceType ?? 'auto',
    tags: options.tags,
    overwrite: options.overwrite ?? true,
    use_filename: false,
    unique_filename: true,
  };

  if (options.metadata) {
    uploadOptions.context = Object.entries(options.metadata)
      .map(([k, v]) => `${k}=${v}`)
      .join('|');
  }

  logger.info('Uploading file to Cloudinary', { filePath, folder: uploadOptions.folder });

  const result: UploadApiResponse = await new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(uploadOptions, (err, res) => {
      if (err) reject(err);
      else if (res) resolve(res);
      else reject(new Error('No response from Cloudinary'));
    });
    createReadStream(filePath).pipe(uploadStream);
  });

  logger.info('Upload complete', { publicId: result.public_id, url: result.secure_url });

  return {
    publicId: result.public_id,
    url: result.url,
    secureUrl: result.secure_url,
    size: result.bytes,
    format: result.format,
    duration: (result as UploadApiResponse & { duration?: number }).duration,
    width: result.width,
    height: result.height,
  };
}

/** Upload a buffer directly to Cloudinary */
export async function uploadBuffer(
  buffer: Buffer,
  options: StorageUploadOptions = {},
): Promise<StorageUploadResult> {
  const uploadOptions: UploadApiOptions = {
    folder: options.folder ?? 'jam-recordings',
    public_id: options.publicId,
    resource_type: options.resourceType ?? 'auto',
    tags: options.tags,
    overwrite: options.overwrite ?? true,
  };

  const result: UploadApiResponse = await new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(uploadOptions, (err, res) => {
        if (err) reject(err);
        else if (res) resolve(res);
        else reject(new Error('No response from Cloudinary'));
      })
      .end(buffer);
  });

  return {
    publicId: result.public_id,
    url: result.url,
    secureUrl: result.secure_url,
    size: result.bytes,
    format: result.format,
    duration: (result as UploadApiResponse & { duration?: number }).duration,
    width: result.width,
    height: result.height,
  };
}

/** Delete a file from Cloudinary by publicId */
export async function deleteFile(
  publicId: string,
  resourceType: 'image' | 'video' | 'raw' = 'video',
): Promise<void> {
  await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  logger.info('Deleted file from Cloudinary', { publicId });
}

/** Generate a signed URL for private resources */
export function generateSignedUrl(publicId: string, expiresAt: number): string {
  return cloudinary.url(publicId, {
    sign_url: true,
    expires_at: expiresAt,
    resource_type: 'video',
  });
}

/** Get video metadata from Cloudinary */
export async function getCloudinaryMetadata(publicId: string): Promise<UploadApiResponse> {
  return cloudinary.api.resource(publicId, { resource_type: 'video' });
}
