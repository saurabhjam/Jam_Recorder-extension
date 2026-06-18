import bcrypt from 'bcryptjs';

import { config } from '../config';
import { prisma } from '../lib/prisma';
import { AppError } from '../middleware/errorHandler';
import { generateUrlSafeToken } from '../utils/crypto';

// ============================================================
// Share Service — no Redis caching; queries DB directly
// ============================================================

export class ShareService {
  async createShareLink(
    userId: string,
    data: {
      recordingId: string;
      expiresAt?: string | null;
      password?: string;
      allowDownload?: boolean;
    },
  ) {
    const recording = await prisma.recording.findUnique({
      where: { id: data.recordingId },
      select: { id: true, userId: true, status: true },
    });

    if (!recording) throw new AppError('Recording not found', 404, 'NOT_FOUND');
    if (recording.userId !== userId)
      throw new AppError('You do not have permission to share this recording', 403, 'FORBIDDEN');
    if (recording.status !== 'READY')
      throw new AppError(
        'Recording must be in READY state to create a share link',
        400,
        'INVALID_STATE',
      );

    const token = generateUrlSafeToken(32);
    let hashedPassword: string | undefined;
    let isPasswordProtected = false;

    if (data.password) {
      hashedPassword = await bcrypt.hash(data.password, config.auth.bcryptRounds);
      isPasswordProtected = true;
    }

    const shareLink = await prisma.shareLink.create({
      data: {
        recordingId: data.recordingId,
        token,
        password: hashedPassword,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        isPasswordProtected,
        allowDownload: data.allowDownload ?? true,
      },
    });

    return {
      id: shareLink.id,
      token: shareLink.token,
      expiresAt: shareLink.expiresAt,
      isPasswordProtected: shareLink.isPasswordProtected,
      allowDownload: shareLink.allowDownload,
      shareUrl: `${config.frontend.url}/share/${shareLink.token}`,
      createdAt: shareLink.createdAt,
    };
  }

  async getSharedRecording(token: string, password?: string) {
    const shareLink = await this.fetchShareLink(token);

    if (!shareLink) throw new AppError('Share link not found or expired', 404, 'NOT_FOUND');

    if (shareLink.expiresAt && shareLink.expiresAt < new Date())
      throw new AppError('This share link has expired', 410, 'LINK_EXPIRED');

    if (shareLink.isPasswordProtected) {
      if (!password)
        throw new AppError('This share link requires a password', 401, 'PASSWORD_REQUIRED');
      if (!shareLink.password)
        throw new AppError('Share link configuration error', 500, 'INTERNAL_ERROR');
      const isPasswordValid = await bcrypt.compare(password, shareLink.password);
      if (!isPasswordValid) throw new AppError('Incorrect password', 401, 'INVALID_PASSWORD');
    }

    if (shareLink.recording.status !== 'READY')
      throw new AppError('Recording is not yet ready', 404, 'NOT_FOUND');

    prisma.shareLink
      .update({ where: { id: shareLink.id }, data: { viewCount: { increment: 1 } } })
      .catch((err) => console.error('Failed to increment share view count:', err));

    const { password: _, ...shareLinkWithoutPassword } = shareLink;
    return { shareLink: shareLinkWithoutPassword, recording: shareLink.recording };
  }

  async deleteShareLink(token: string, userId: string): Promise<void> {
    const shareLink = await prisma.shareLink.findUnique({
      where: { token },
      include: { recording: { select: { userId: true } } },
    });

    if (!shareLink) throw new AppError('Share link not found', 404, 'NOT_FOUND');
    if (shareLink.recording.userId !== userId)
      throw new AppError('You do not have permission to delete this share link', 403, 'FORBIDDEN');

    await prisma.shareLink.delete({ where: { token } });
  }

  async getShareLinksForRecording(recordingId: string, userId: string) {
    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: { userId: true },
    });

    if (!recording) throw new AppError('Recording not found', 404, 'NOT_FOUND');
    if (recording.userId !== userId) throw new AppError('Unauthorized', 403, 'FORBIDDEN');

    const shareLinks = await prisma.shareLink.findMany({
      where: { recordingId },
      select: {
        id: true,
        token: true,
        expiresAt: true,
        isPasswordProtected: true,
        allowDownload: true,
        viewCount: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return shareLinks.map((sl) => ({
      ...sl,
      shareUrl: `${config.frontend.url}/share/${sl.token}`,
    }));
  }

  private async fetchShareLink(token: string) {
    return prisma.shareLink.findUnique({
      where: { token },
      include: {
        recording: true,
      },
    });
  }
}

export const shareService = new ShareService();
