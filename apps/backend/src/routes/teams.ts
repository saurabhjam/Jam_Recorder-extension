import { Router, type Request, type Response, type NextFunction } from 'express';

import { teamService } from '../services/team.service';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  createTeamSchema,
  inviteMemberSchema,
  acceptInviteSchema,
  updateMemberRoleSchema,
} from '../schemas/recording.schema';

const router = Router();

// ============================================================
// POST /teams — Create a team
// ============================================================
router.post(
  '/',
  requireAuth,
  validate(createTeamSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const team = await teamService.createTeam(req.user!.id, req.body);
      res.status(201).json({
        success: true,
        message: 'Team created successfully',
        data: team,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// GET /teams/me — Get my team
// ============================================================
router.get(
  '/me',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const team = await teamService.getMyTeam(req.user!.id);
      res.json({ success: true, data: team });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// GET /teams/recordings — Get team recordings
// ============================================================
router.get(
  '/recordings',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const page = parseInt(String(req.query['page'] ?? '1'), 10);
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '20'), 10), 100);

      const result = await teamService.getTeamRecordings(req.user!.id, { page, limit });
      res.json({
        success: true,
        data: result.recordings,
        total: result.total,
        page: result.page,
        limit: result.limit,
        hasMore: result.hasMore,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// POST /teams/invite — Invite a member
// ============================================================
router.post(
  '/invite',
  requireAuth,
  validate(inviteMemberSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const invite = await teamService.inviteMember(req.user!.id, req.body);
      res.status(201).json({
        success: true,
        message: `Invitation sent to ${invite.email}`,
        data: invite,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// POST /teams/invite/accept — Accept a team invite
// ============================================================
router.post(
  '/invite/accept',
  requireAuth,
  validate(acceptInviteSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { token } = req.body as { token: string };
      const team = await teamService.acceptInvite(req.user!.id, token);
      res.json({
        success: true,
        message: `You have joined team ${team.name}`,
        data: team,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// DELETE /teams/members/:userId — Remove a member
// ============================================================
router.delete(
  '/members/:userId',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await teamService.removeMember(req.user!.id, req.params['userId']!);
      res.json({
        success: true,
        message: 'Member removed from team',
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// PUT /teams/members/:userId/role — Update member role
// ============================================================
router.put(
  '/members/:userId/role',
  requireAuth,
  validate(updateMemberRoleSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await teamService.updateMemberRole(
        req.user!.id,
        req.params['userId']!,
        req.body,
      );
      res.json({
        success: true,
        message: 'Member role updated',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
