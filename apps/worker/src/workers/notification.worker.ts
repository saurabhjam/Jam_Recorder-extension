import { Worker, Job, type ConnectionOptions } from 'bullmq';
import { prisma } from '../lib/prisma';
import { logger, createChildLogger } from '../utils/logger';

const QUEUE_NAME = process.env.NOTIFICATION_QUEUE_NAME ?? 'notifications';

export interface NotificationJobData {
  userId: string;
  type: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}

/** Send an email (placeholder — replace with real SMTP/SendGrid implementation) */
async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  // TODO: Integrate with nodemailer / SendGrid / Resend
  // For now, just log the email
  logger.info('[Email] Would send email', { to, subject });

  /*
  // Example with nodemailer:
  const transporter = nodemailer.createTransporter({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT ?? '587'),
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  })

  await transporter.sendMail({
    from:    process.env.EMAIL_FROM ?? 'noreply@snaptrace.app',
    to,
    subject,
    html,
  })
  */
}

/** Build email HTML for a notification type */
function buildEmailHtml(
  type: string,
  title: string,
  message: string,
  metadata?: Record<string, unknown>,
): string {
  const recordingId = metadata?.recordingId as string | undefined;
  const shareUrl = recordingId
    ? `${process.env.FRONTEND_URL ?? 'https://app.snaptrace.app'}/share/${recordingId}`
    : undefined;

  return `
<!DOCTYPE html>
<html>
<body style="font-family: Inter, system-ui, sans-serif; background: #0a0d14; color: #f9fafb; max-width: 600px; margin: 0 auto; padding: 24px;">
  <div style="text-align: center; margin-bottom: 24px;">
    <span style="font-size: 24px; font-weight: 700; color: #8b5cf6;">SnapTrace</span>
  </div>
  <div style="background: #111827; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 24px;">
    <h2 style="margin: 0 0 8px; font-size: 18px;">${title}</h2>
    <p style="color: #9ca3af; margin: 0 0 20px; line-height: 1.6;">${message}</p>
    ${shareUrl ? `<a href="${shareUrl}" style="display: inline-block; background: #7c3aed; color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: 500;">View recording</a>` : ''}
  </div>
  <p style="text-align: center; font-size: 12px; color: #6b7280; margin-top: 24px;">
    You received this email because you have an account on SnapTrace.<br>
    <a href="${process.env.FRONTEND_URL ?? 'https://app.snaptrace.app'}/settings" style="color: #8b5cf6;">Manage notifications</a>
  </p>
</body>
</html>
  `.trim();
}

async function processNotificationJob(job: Job<NotificationJobData>): Promise<void> {
  const { userId, type, title, message, metadata } = job.data;
  const log = createChildLogger({ userId, type, jobId: job.id });

  log.info('Processing notification', { type, title });

  try {
    // ── 1. Persist notification to database ────────────────────────────
    await prisma.notification.create({
      data: {
        userId,
        type: type as 'RECORDING_READY' | 'COMMENT' | 'TEAM_INVITE' | 'SHARE_VIEWED',
        title,
        message,
        isRead: false,
        metadata: metadata ?? {},
      },
    });

    await job.updateProgress(50);
    log.debug('Notification stored in DB');

    // ── 2. Look up user for email delivery ─────────────────────────────
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true },
    });

    if (!user) {
      log.warn('User not found for notification delivery');
      return;
    }

    // ── 3. Send email (based on type and user preferences) ─────────────
    const EMAILABLE_TYPES = ['RECORDING_READY', 'TEAM_INVITE'];

    if (EMAILABLE_TYPES.includes(type)) {
      const html = buildEmailHtml(type, title, message, metadata);
      await sendEmail(user.email, title, html);
      log.debug('Email sent', { to: user.email });
    }

    await job.updateProgress(100);
    log.info('Notification processed successfully');
  } catch (error) {
    log.error('Failed to process notification', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** Create and start the notification worker */
export function createNotificationWorker(
  connection: ConnectionOptions,
): Worker<NotificationJobData> {
  const worker = new Worker<NotificationJobData>(QUEUE_NAME, processNotificationJob, {
    connection,
    concurrency: 10,
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  });

  worker.on('active', (job) => {
    logger.info(`[NotificationWorker] Job started`, { jobId: job.id, type: job.data.type });
  });

  worker.on('completed', (job) => {
    logger.info(`[NotificationWorker] Job completed`, { jobId: job.id });
  });

  worker.on('failed', (job, err) => {
    logger.error(`[NotificationWorker] Job failed`, {
      jobId: job?.id,
      error: err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error(`[NotificationWorker] Worker error`, { error: err.message });
  });

  logger.info(`[NotificationWorker] Started`, { queue: QUEUE_NAME });

  return worker;
}
