import nodemailer from 'nodemailer';
import { config } from '../config';

const transporter = nodemailer.createTransport({
  host: config.email.host,
  port: config.email.port,
  secure: config.email.port === 465,
  auth: config.email.user ? { user: config.email.user, pass: config.email.pass } : undefined,
});

export async function sendPasswordResetEmail(
  to: string,
  name: string,
  resetToken: string,
): Promise<void> {
  const resetUrl = `${config.server.frontendUrl}/reset-password?token=${resetToken}`;

  await transporter.sendMail({
    from: `"SnapTrace" <${config.email.from}>`,
    to,
    subject: 'Reset your SnapTrace password',
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f17; color: #e2e8f0; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 40px auto; background: #1a1a2e; border: 1px solid #2d2d4e; border-radius: 16px; overflow: hidden; }
    .header { background: linear-gradient(135deg, #6366f1 0%, #3b82f6 100%); padding: 32px; text-align: center; }
    .header h1 { color: white; margin: 0; font-size: 24px; font-weight: 700; }
    .body { padding: 32px; }
    .body p { color: #94a3b8; line-height: 1.6; margin: 0 0 16px; }
    .btn { display: inline-block; background: linear-gradient(135deg, #6366f1 0%, #3b82f6 100%); color: white !important; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-weight: 600; font-size: 16px; margin: 24px 0; }
    .footer { padding: 24px 32px; border-top: 1px solid #2d2d4e; }
    .footer p { color: #4a5568; font-size: 12px; margin: 0; }
    .code { background: #0f0f17; border: 1px solid #2d2d4e; border-radius: 8px; padding: 12px 16px; font-family: monospace; font-size: 14px; color: #a78bfa; margin: 16px 0; word-break: break-all; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>⚡ SnapTrace</h1>
    </div>
    <div class="body">
      <p>Hi ${name},</p>
      <p>Someone requested a password reset for your SnapTrace account. If this was you, click the button below to reset your password.</p>
      <div style="text-align: center;">
        <a href="${resetUrl}" class="btn">Reset Password</a>
      </div>
      <p>Or copy this link:</p>
      <div class="code">${resetUrl}</div>
      <p>This link expires in <strong>1 hour</strong>. If you didn't request a password reset, you can safely ignore this email.</p>
    </div>
    <div class="footer">
      <p>© 2024 SnapTrace. All rights reserved.</p>
      <p>You're receiving this email because a password reset was requested for your account.</p>
    </div>
  </div>
</body>
</html>`,
  });
}

export async function sendWelcomeEmail(to: string, name: string): Promise<void> {
  await transporter.sendMail({
    from: `"SnapTrace" <${config.email.from}>`,
    to,
    subject: 'Welcome to SnapTrace!',
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f17; color: #e2e8f0; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 40px auto; background: #1a1a2e; border: 1px solid #2d2d4e; border-radius: 16px; overflow: hidden; }
    .header { background: linear-gradient(135deg, #6366f1 0%, #3b82f6 100%); padding: 32px; text-align: center; }
    .header h1 { color: white; margin: 0; font-size: 24px; font-weight: 700; }
    .body { padding: 32px; }
    .body p { color: #94a3b8; line-height: 1.6; margin: 0 0 16px; }
    .feature { display: flex; align-items: flex-start; margin: 16px 0; }
    .feature-icon { font-size: 24px; margin-right: 16px; }
    .feature-text h3 { color: #e2e8f0; margin: 0 0 4px; font-size: 16px; }
    .feature-text p { color: #94a3b8; margin: 0; font-size: 14px; }
    .btn { display: inline-block; background: linear-gradient(135deg, #6366f1 0%, #3b82f6 100%); color: white !important; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-weight: 600; font-size: 16px; margin: 24px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>⚡ SnapTrace</h1></div>
    <div class="body">
      <p>Hi ${name}, welcome to SnapTrace!</p>
      <p>You're all set. Start recording bugs, walkthroughs, and async updates in seconds.</p>
      <div class="feature">
        <div class="feature-icon">🎬</div>
        <div class="feature-text"><h3>Screen Recording</h3><p>Capture your screen, tab, or webcam with one click.</p></div>
      </div>
      <div class="feature">
        <div class="feature-icon">🐛</div>
        <div class="feature-text"><h3>Bug Reporting</h3><p>Annotate screenshots with console logs and browser info auto-captured.</p></div>
      </div>
      <div class="feature">
        <div class="feature-icon">🔗</div>
        <div class="feature-text"><h3>Instant Sharing</h3><p>Get a shareable link the moment your recording finishes uploading.</p></div>
      </div>
      <div style="text-align: center;">
        <a href="${config.server.frontendUrl}/dashboard" class="btn">Open Dashboard</a>
      </div>
    </div>
  </div>
</body>
</html>`,
  });
}
