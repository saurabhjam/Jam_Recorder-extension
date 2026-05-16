/**
 * SnapTrace – Database Seeder
 *
 * Creates initial development/demo data:
 *   - 1 Admin user
 *   - 1 Regular user
 *   - 1 Team (both users are members via User.teamId)
 *   - 5 Sample recordings
 *
 * Usage (from repo root):
 *   pnpm --filter @snaptrace/backend run seed
 */

import { PrismaClient, RecordingStatus, RecordingType, Plan } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

// ── Load environment ──────────────────────────────────────────────────────────
// When running from apps/backend, look for .env in that directory
const envPaths = [
  path.resolve(process.cwd(), '.env'), // apps/backend/.env  (when run from backend)
  path.resolve(__dirname, '../apps/backend/.env'), // from repo root
  path.resolve(__dirname, '../../apps/backend/.env'), // fallback
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log(`[seed] Loaded env from ${envPath}`);
    break;
  }
}

// ── Prisma client ─────────────────────────────────────────────────────────────
const prisma = new PrismaClient({
  log: ['warn', 'error'],
});

const BCRYPT_ROUNDS = 12;

function randomPastDate(maxDaysAgo: number): Date {
  const msAgo = Math.floor(Math.random() * maxDaysAgo * 24 * 60 * 60 * 1000);
  return new Date(Date.now() - msAgo);
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Sample recordings ─────────────────────────────────────────────────────────
const SAMPLE_RECORDINGS: Array<{
  title: string;
  description: string;
  duration: number;
  status: RecordingStatus;
  type: RecordingType;
  url: string | null;
  thumbnailUrl: string | null;
  viewCount: number;
  isPublic: boolean;
}> = [
  {
    title: 'Onboarding Flow – Bug Reproduction',
    description:
      'Recorded while reproducing the sign-up form validation bug reported in #241. The error occurs when the email field loses focus before submission.',
    duration: 127,
    status: RecordingStatus.READY,
    type: RecordingType.SCREEN,
    url: 'https://res.cloudinary.com/demo/video/upload/v1/snaptrace/recordings/recording-001.mp4',
    thumbnailUrl:
      'https://res.cloudinary.com/demo/image/upload/v1/snaptrace/recordings/thumb-001.jpg',
    viewCount: 14,
    isPublic: true,
  },
  {
    title: 'API Performance – Slow Recording List Endpoint',
    description:
      'Demonstrating N+1 query issue in /api/recordings. Response time is 3.2s for 50 recordings. Fixed by adding include clause to Prisma query.',
    duration: 83,
    status: RecordingStatus.READY,
    type: RecordingType.SCREEN,
    url: 'https://res.cloudinary.com/demo/video/upload/v1/snaptrace/recordings/recording-002.mp4',
    thumbnailUrl:
      'https://res.cloudinary.com/demo/image/upload/v1/snaptrace/recordings/thumb-002.jpg',
    viewCount: 7,
    isPublic: false,
  },
  {
    title: 'Dashboard UI – Dark Mode Preview',
    description:
      'Walkthrough of the new dark mode implementation. Showing how CSS variables cascade and the toggle animation.',
    duration: 210,
    status: RecordingStatus.READY,
    type: RecordingType.TAB,
    url: 'https://res.cloudinary.com/demo/video/upload/v1/snaptrace/recordings/recording-003.mp4',
    thumbnailUrl:
      'https://res.cloudinary.com/demo/image/upload/v1/snaptrace/recordings/thumb-003.jpg',
    viewCount: 32,
    isPublic: true,
  },
  {
    title: 'Extension Upload Flow – End to End',
    description:
      'Complete walkthrough of recording with the Chrome extension, including annotation, upload progress, and sharing.',
    duration: 345,
    status: RecordingStatus.PROCESSING,
    type: RecordingType.SCREEN,
    url: null,
    thumbnailUrl: null,
    viewCount: 0,
    isPublic: false,
  },
  {
    title: 'Team Permissions – Role-Based Access Control',
    description:
      'Demonstrating how admin vs member vs viewer roles restrict access to recordings and team settings.',
    duration: 178,
    status: RecordingStatus.READY,
    type: RecordingType.WEBCAM,
    url: 'https://res.cloudinary.com/demo/video/upload/v1/snaptrace/recordings/recording-005.mp4',
    thumbnailUrl:
      'https://res.cloudinary.com/demo/image/upload/v1/snaptrace/recordings/thumb-005.jpg',
    viewCount: 5,
    isPublic: true,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Main seed function
// ─────────────────────────────────────────────────────────────────────────────
async function seed(): Promise<void> {
  console.log('\n[seed] Starting database seed...\n');

  // ── 1. Create Team ──────────────────────────────────────────────────────────
  console.log('[seed] Creating sample team...');

  const team = await prisma.team.upsert({
    where: { slug: 'acme-engineering' },
    update: {},
    create: {
      name: 'Acme Engineering',
      slug: 'acme-engineering',
      plan: Plan.PRO,
    },
  });

  console.log(`  Created team: ${team.name} (id: ${team.id})`);

  // ── 2. Create Admin User ────────────────────────────────────────────────────
  console.log('[seed] Creating admin user...');

  const adminPasswordHash = await bcrypt.hash('Admin@SnapTrace2024!', BCRYPT_ROUNDS);

  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@snaptrace.app' },
    update: {},
    create: {
      email: 'admin@snaptrace.app',
      name: 'Admin User',
      password: adminPasswordHash,
      avatar: 'https://ui-avatars.com/api/?name=Admin+User&background=6366f1&color=fff&size=128',
      isVerified: true,
      isActive: true,
      teamId: team.id,
    },
  });

  console.log(`  Created admin: ${adminUser.email} (id: ${adminUser.id})`);

  // ── 3. Create Demo User ─────────────────────────────────────────────────────
  console.log('[seed] Creating demo user...');

  const userPasswordHash = await bcrypt.hash('User@SnapTrace2024!', BCRYPT_ROUNDS);

  const regularUser = await prisma.user.upsert({
    where: { email: 'demo@snaptrace.app' },
    update: {},
    create: {
      email: 'demo@snaptrace.app',
      name: 'Demo User',
      password: userPasswordHash,
      avatar: 'https://ui-avatars.com/api/?name=Demo+User&background=8b5cf6&color=fff&size=128',
      isVerified: true,
      isActive: true,
      teamId: team.id,
    },
  });

  console.log(`  Created user: ${regularUser.email} (id: ${regularUser.id})`);

  // ── 4. Create Sample Recordings ─────────────────────────────────────────────
  console.log('[seed] Creating sample recordings...');

  for (const rec of SAMPLE_RECORDINGS) {
    const author = Math.random() > 0.5 ? adminUser : regularUser;
    const createdAt = randomPastDate(30);

    const recording = await prisma.recording.create({
      data: {
        title: rec.title,
        description: rec.description,
        duration: rec.duration,
        status: rec.status,
        type: rec.type,
        url: rec.url,
        thumbnailUrl: rec.thumbnailUrl,
        viewCount: rec.viewCount,
        isPublic: rec.isPublic,
        allowDownload: true,
        userId: author.id,
        teamId: team.id,
        createdAt,
        updatedAt: new Date(createdAt.getTime() + randomInt(0, 3_600_000)),
        metadata: {
          browser: 'Chrome',
          os: 'macOS',
          screenResolution: '2560x1440',
          fps: 30,
        },
      },
    });

    console.log(`  Created recording: "${recording.title}" (${recording.id})`);
  }

  // ── 5. Print summary ─────────────────────────────────────────────────────────
  const [userCount, teamCount, recordingCount] = await Promise.all([
    prisma.user.count(),
    prisma.team.count(),
    prisma.recording.count(),
  ]);

  console.log('\n' + '─'.repeat(60));
  console.log('[seed] Seed completed successfully!');
  console.log('─'.repeat(60));
  console.log(`  Users:      ${userCount}`);
  console.log(`  Teams:      ${teamCount}`);
  console.log(`  Recordings: ${recordingCount}`);
  console.log('─'.repeat(60));
  console.log('\n  Login credentials:');
  console.log('    Admin:  admin@snaptrace.app  /  Admin@SnapTrace2024!');
  console.log('    Demo:   demo@snaptrace.app   /  User@SnapTrace2024!');
  console.log('');
}

// ── Run ───────────────────────────────────────────────────────────────────────
seed()
  .catch((err) => {
    console.error('[seed] Fatal error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
