import { AppError } from '../middleware/errorHandler';

// ============================================================
// Team Service — DISABLED
// Team functionality has been removed along with the User/Team
// tables. All methods throw 501 Not Implemented so that routes
// compile without errors and return a clear error at runtime.
// ============================================================

const NOT_IMPLEMENTED = () =>
  new AppError('Team functionality is not available in this deployment', 501, 'NOT_IMPLEMENTED');

export class TeamService {
  async createTeam(_userId: string, _data: unknown): Promise<never> {
    throw NOT_IMPLEMENTED();
  }

  async getMyTeam(_userId: string): Promise<never> {
    throw NOT_IMPLEMENTED();
  }

  async inviteMember(_ownerId: string, _data: unknown): Promise<never> {
    throw NOT_IMPLEMENTED();
  }

  async acceptInvite(_userId: string, _token: string): Promise<never> {
    throw NOT_IMPLEMENTED();
  }

  async removeMember(_ownerId: string, _memberId: string): Promise<never> {
    throw NOT_IMPLEMENTED();
  }

  async updateMemberRole(_ownerId: string, _memberId: string, _data: unknown): Promise<never> {
    throw NOT_IMPLEMENTED();
  }

  async getTeamRecordings(
    _userId: string,
    _query: { page?: number; limit?: number },
  ): Promise<never> {
    throw NOT_IMPLEMENTED();
  }
}

export const teamService = new TeamService();
