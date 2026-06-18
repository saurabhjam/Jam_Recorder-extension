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

const router: Router = Router();

// All team endpoints are stubbed — teamService always throws 501.

router.post(
  '/',
  requireAuth,
  validate(createTeamSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await teamService.createTeam(req.user!.id, req.body);
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/me',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await teamService.getMyTeam(req.user!.id);
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/recordings',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const page = parseInt(String(req.query['page'] ?? '1'), 10);
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '20'), 10), 100);
      await teamService.getTeamRecordings(req.user!.id, { page, limit });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/invite',
  requireAuth,
  validate(inviteMemberSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await teamService.inviteMember(req.user!.id, req.body);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/invite/accept',
  requireAuth,
  validate(acceptInviteSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { token } = req.body as { token: string };
      await teamService.acceptInvite(req.user!.id, token);
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/members/:userId',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await teamService.removeMember(req.user!.id, req.params['userId']!);
    } catch (error) {
      next(error);
    }
  },
);

router.put(
  '/members/:userId/role',
  requireAuth,
  validate(updateMemberRoleSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await teamService.updateMemberRole(req.user!.id, req.params['userId']!, req.body);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
