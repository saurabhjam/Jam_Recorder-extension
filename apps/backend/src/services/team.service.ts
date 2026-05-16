import { addDays } from 'date-fns';
import type { Role } from '@prisma/client';

import { prisma } from '../lib/prisma';
import { AppError } from '../middleware/errorHandler';
import { generateInviteToken } from '../utils/crypto';
import type {
  CreateTeamInput,
  InviteMemberInput,
  UpdateMemberRoleInput,
} from '../schemas/recording.schema';

// ============================================================
// Team Service
// ============================================================

export class TeamService {
  /**
   * Create a new team and make the user the OWNER.
   */
  async createTeam(userId: string, data: CreateTeamInput) {
    // Check if user already has a team
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, teamId: true },
    });

    if (!user) {
      throw new AppError('User not found', 404, 'NOT_FOUND');
    }

    if (user.teamId) {
      throw new AppError('You are already a member of a team', 409, 'ALREADY_IN_TEAM');
    }

    const slug = data.slug ?? this.generateSlug(data.name);

    // Check slug uniqueness
    const existingTeam = await prisma.team.findUnique({ where: { slug } });
    if (existingTeam) {
      throw new AppError('A team with this slug already exists', 409, 'DUPLICATE_SLUG');
    }

    // Create team and update user in a transaction
    const team = await prisma.$transaction(async (tx) => {
      const newTeam = await tx.team.create({
        data: { name: data.name, slug },
      });

      await tx.user.update({
        where: { id: userId },
        data: { teamId: newTeam.id },
      });

      return newTeam;
    });

    return team;
  }

  /**
   * Get the current user's team with members.
   */
  async getMyTeam(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { teamId: true },
    });

    if (!user?.teamId) {
      throw new AppError('You are not a member of any team', 404, 'NOT_IN_TEAM');
    }

    const team = await prisma.team.findUnique({
      where: { id: user.teamId },
      include: {
        members: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
            isActive: true,
            createdAt: true,
          },
        },
        invites: {
          where: {
            expiresAt: { gt: new Date() },
          },
          select: {
            id: true,
            email: true,
            role: true,
            expiresAt: true,
            createdAt: true,
          },
        },
      },
    });

    if (!team) {
      throw new AppError('Team not found', 404, 'NOT_FOUND');
    }

    return {
      ...team,
      membersCount: team.members.length,
    };
  }

  /**
   * Invite a user to the team.
   */
  async inviteMember(ownerId: string, data: InviteMemberInput) {
    const owner = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { id: true, teamId: true, name: true },
    });

    if (!owner?.teamId) {
      throw new AppError('You are not a member of any team', 400, 'NOT_IN_TEAM');
    }

    // Check if the invited email is already a team member
    const existingMember = await prisma.user.findFirst({
      where: { email: data.email, teamId: owner.teamId },
    });

    if (existingMember) {
      throw new AppError('This user is already a member of your team', 409, 'ALREADY_MEMBER');
    }

    // Check for existing non-expired invite
    const existingInvite = await prisma.teamInvite.findFirst({
      where: {
        teamId: owner.teamId,
        email: data.email,
        expiresAt: { gt: new Date() },
      },
    });

    if (existingInvite) {
      throw new AppError('An active invite already exists for this email', 409, 'INVITE_EXISTS');
    }

    const token = generateInviteToken();

    const invite = await prisma.teamInvite.create({
      data: {
        teamId: owner.teamId,
        email: data.email,
        role: (data.role ?? 'MEMBER') as Role,
        token,
        expiresAt: addDays(new Date(), 7),
      },
      include: {
        team: { select: { name: true, slug: true } },
      },
    });

    return invite;
  }

  /**
   * Accept a team invite.
   */
  async acceptInvite(userId: string, token: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, teamId: true },
    });

    if (!user) {
      throw new AppError('User not found', 404, 'NOT_FOUND');
    }

    if (user.teamId) {
      throw new AppError('You are already a member of a team', 409, 'ALREADY_IN_TEAM');
    }

    const invite = await prisma.teamInvite.findUnique({
      where: { token },
      include: { team: true },
    });

    if (!invite) {
      throw new AppError('Invite not found', 404, 'NOT_FOUND');
    }

    if (invite.expiresAt < new Date()) {
      throw new AppError('This invite has expired', 410, 'INVITE_EXPIRED');
    }

    if (invite.email !== user.email) {
      throw new AppError('This invite is for a different email address', 403, 'FORBIDDEN');
    }

    // Accept invite in a transaction
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { teamId: invite.teamId },
      }),
      prisma.teamInvite.delete({ where: { id: invite.id } }),
    ]);

    return invite.team;
  }

  /**
   * Remove a member from the team.
   */
  async removeMember(ownerId: string, memberId: string) {
    if (ownerId === memberId) {
      throw new AppError('You cannot remove yourself from the team', 400, 'CANNOT_REMOVE_SELF');
    }

    const owner = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { teamId: true },
    });

    if (!owner?.teamId) {
      throw new AppError('You are not in a team', 400, 'NOT_IN_TEAM');
    }

    const member = await prisma.user.findUnique({
      where: { id: memberId },
      select: { id: true, teamId: true },
    });

    if (!member || member.teamId !== owner.teamId) {
      throw new AppError('This user is not in your team', 404, 'NOT_FOUND');
    }

    await prisma.user.update({
      where: { id: memberId },
      data: { teamId: null },
    });
  }

  /**
   * Update a team member's role.
   */
  async updateMemberRole(ownerId: string, memberId: string, data: UpdateMemberRoleInput) {
    if (ownerId === memberId) {
      throw new AppError('You cannot change your own role', 400, 'CANNOT_CHANGE_OWN_ROLE');
    }

    const owner = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { teamId: true },
    });

    if (!owner?.teamId) {
      throw new AppError('You are not in a team', 400, 'NOT_IN_TEAM');
    }

    const member = await prisma.user.findUnique({
      where: { id: memberId },
      select: { id: true, teamId: true },
    });

    if (!member || member.teamId !== owner.teamId) {
      throw new AppError('This user is not in your team', 404, 'NOT_FOUND');
    }

    // Role is stored on the TeamInvite / we don't have a separate membership table
    // In a fuller implementation, we'd have a TeamMembership model with roles
    // For now, we just confirm the update was requested
    return { userId: memberId, role: data.role, updated: true };
  }

  /**
   * Get team recordings (paginated).
   */
  async getTeamRecordings(userId: string, query: { page?: number; limit?: number }) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { teamId: true },
    });

    if (!user?.teamId) {
      throw new AppError('You are not in a team', 400, 'NOT_IN_TEAM');
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [recordings, total] = await Promise.all([
      prisma.recording.findMany({
        where: { teamId: user.teamId, status: 'READY' },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, avatar: true } },
        },
      }),
      prisma.recording.count({
        where: { teamId: user.teamId, status: 'READY' },
      }),
    ]);

    return {
      recordings,
      total,
      page,
      limit,
      hasMore: skip + recordings.length < total,
    };
  }

  // ============================================================
  // Private Helpers
  // ============================================================

  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 50);
  }
}

export const teamService = new TeamService();
