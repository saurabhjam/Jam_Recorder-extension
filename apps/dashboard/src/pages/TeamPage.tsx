import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { UserPlus, MoreHorizontal, Shield, Trash2, Mail, Clock, Users, Crown } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@components/ui/Button';
import { Input } from '@components/ui/Input';
import { Badge } from '@components/ui/Badge';
import { Modal, ModalFooter } from '@components/ui/Modal';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@components/ui/Tabs';
import {
  Dropdown,
  DropdownTrigger,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
} from '@components/ui/Dropdown';
import { SkeletonTable } from '@components/Skeleton';
import { api } from '@services/api';
import { getInitials, formatDate } from '@utils/index';
import type { UserRole } from '@snaptrace/types';

const ROLE_VARIANTS: Record<UserRole, 'success' | 'warning' | 'purple' | 'default'> = {
  OWNER: 'warning',
  ADMIN: 'purple',
  MEMBER: 'default',
  VIEWER: 'default',
};

const ROLES: UserRole[] = ['ADMIN', 'MEMBER', 'VIEWER'];

export default function TeamPage() {
  const qc = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<UserRole>('MEMBER');
  const [removeId, setRemoveId] = useState<string | null>(null);

  const { data: team, isLoading: teamLoad } = useQuery({
    queryKey: ['team'],
    queryFn: api.getTeam.bind(api),
  });
  const { data: members, isLoading: membersLoad } = useQuery({
    queryKey: ['team-members'],
    queryFn: api.getTeamMembers.bind(api),
  });
  const { data: invites, isLoading: invitesLoad } = useQuery({
    queryKey: ['team-invites'],
    queryFn: api.getPendingInvites.bind(api),
  });

  const inviteMutation = useMutation({
    mutationFn: () => api.inviteMember({ email: inviteEmail, role: inviteRole }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team-invites'] });
      toast.success(`Invite sent to ${inviteEmail}`);
      setInviteOpen(false);
      setInviteEmail('');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: UserRole }) =>
      api.updateMemberRole(userId, { role }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team-members'] });
      toast.success('Role updated');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => api.removeMember(userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team-members'] });
      setRemoveId(null);
      toast.success('Member removed');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const cancelInviteMutation = useMutation({
    mutationFn: (id: string) => api.cancelInvite(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team-invites'] });
      toast.success('Invite cancelled');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleInviteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    inviteMutation.mutate();
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Team</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage your team members and permissions</p>
        </div>
        <Button leftIcon={<UserPlus className="h-4 w-4" />} onClick={() => setInviteOpen(true)}>
          Invite member
        </Button>
      </div>

      {/* Team card */}
      {team && (
        <div className="card p-5 flex items-center gap-4">
          <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-violet-600 to-blue-500 flex items-center justify-center text-white font-bold text-lg flex-shrink-0">
            {getInitials(team.name)}
          </div>
          <div className="flex-1">
            <p className="font-semibold text-gray-100">{team.name}</p>
            <p className="text-sm text-gray-500">/{team.slug}</p>
          </div>
          <Badge variant={team.plan === 'FREE' ? 'default' : 'purple'}>{team.plan}</Badge>
          <div className="flex items-center gap-1.5 text-sm text-gray-500">
            <Users className="h-4 w-4" />
            {members?.length ?? 0} member{members?.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}

      <Tabs defaultValue="members">
        <TabsList variant="underline">
          <TabsTrigger value="members" variant="underline">
            <Users className="h-3.5 w-3.5" />
            Members {members ? `(${members.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="invites" variant="underline">
            <Mail className="h-3.5 w-3.5" />
            Pending invites {invites?.length ? `(${invites.length})` : ''}
          </TabsTrigger>
        </TabsList>

        {/* ── Members ── */}
        <TabsContent value="members" className="pt-4">
          {membersLoad ? (
            <SkeletonTable rows={4} cols={5} />
          ) : (
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    {['Member', 'Email', 'Role', 'Joined', ''].map((h) => (
                      <th
                        key={h}
                        className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {members?.map((m) => (
                    <tr key={m.userId} className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="h-8 w-8 rounded-full bg-gradient-to-br from-violet-600 to-blue-500 flex items-center justify-center text-xs font-semibold text-white flex-shrink-0">
                            {m.user ? getInitials(m.user.name) : '?'}
                          </div>
                          <div>
                            <p className="font-medium text-gray-200">{m.user?.name ?? 'Unknown'}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">{m.user?.name}</td>
                      <td className="px-4 py-3">
                        <Badge variant={ROLE_VARIANTS[m.role] ?? 'default'}>
                          {m.role === 'OWNER' && <Crown className="h-2.5 w-2.5" />}
                          {m.role}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">{formatDate(m.joinedAt)}</td>
                      <td className="px-4 py-3 text-right">
                        {m.role !== 'OWNER' && (
                          <Dropdown>
                            <DropdownTrigger asChild>
                              <button className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-white/[0.06] transition-colors">
                                <MoreHorizontal className="h-4 w-4" />
                              </button>
                            </DropdownTrigger>
                            <DropdownContent align="end">
                              <div className="px-2 py-1 text-xs text-gray-500 font-medium">
                                Change role
                              </div>
                              {ROLES.map((r) => (
                                <DropdownItem
                                  key={r}
                                  icon={<Shield className="h-3.5 w-3.5" />}
                                  onSelect={() =>
                                    updateRoleMutation.mutate({ userId: m.userId, role: r })
                                  }
                                  className={m.role === r ? 'text-violet-400' : ''}
                                >
                                  {r}
                                </DropdownItem>
                              ))}
                              <DropdownSeparator />
                              <DropdownItem
                                destructive
                                icon={<Trash2 className="h-3.5 w-3.5" />}
                                onSelect={() => setRemoveId(m.userId)}
                              >
                                Remove member
                              </DropdownItem>
                            </DropdownContent>
                          </Dropdown>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        {/* ── Pending invites ── */}
        <TabsContent value="invites" className="pt-4">
          {invitesLoad ? (
            <SkeletonTable rows={3} cols={4} />
          ) : invites && invites.length > 0 ? (
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    {['Email', 'Role', 'Expires', ''].map((h) => (
                      <th
                        key={h}
                        className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {invites.map((inv) => (
                    <tr key={inv.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Mail className="h-4 w-4 text-gray-500" />
                          <span className="text-gray-300">{inv.email}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={ROLE_VARIANTS[inv.role] ?? 'default'}>{inv.role}</Badge>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        <div className="flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" />
                          {formatDate(inv.expiresAt)}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="xs"
                          className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                          onClick={() => cancelInviteMutation.mutate(inv.id)}
                          loading={cancelInviteMutation.isPending}
                        >
                          Cancel
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Mail className="h-8 w-8 text-gray-700 mb-3" />
              <p className="text-sm text-gray-500">No pending invites</p>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ── Invite modal ──────────────────────────────────────────── */}
      <Modal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invite team member"
        description="Send an invitation email to add someone to your team."
        size="sm"
      >
        <form onSubmit={handleInviteSubmit} className="space-y-4">
          <Input
            label="Email address"
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="colleague@company.com"
            leftAddon={<Mail className="h-4 w-4" />}
          />

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-gray-300">Role</label>
            <div className="flex gap-2">
              {ROLES.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setInviteRole(r)}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-all ${
                    inviteRole === r
                      ? 'bg-violet-600/20 border-violet-500/40 text-violet-300'
                      : 'bg-transparent border-white/[0.08] text-gray-400 hover:text-gray-300'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              {inviteRole === 'ADMIN' && 'Admins can manage recordings and members'}
              {inviteRole === 'MEMBER' && 'Members can create and view recordings'}
              {inviteRole === 'VIEWER' && 'Viewers can only watch shared recordings'}
            </p>
          </div>

          <ModalFooter>
            <Button variant="secondary" type="button" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={inviteMutation.isPending} disabled={!inviteEmail.trim()}>
              Send invite
            </Button>
          </ModalFooter>
        </form>
      </Modal>

      {/* ── Remove confirm ────────────────────────────────────────── */}
      <Modal
        open={!!removeId}
        onClose={() => setRemoveId(null)}
        title="Remove member"
        description="This will revoke their access. They can be re-invited later."
        size="sm"
      >
        <ModalFooter>
          <Button variant="secondary" onClick={() => setRemoveId(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={removeMutation.isPending}
            onClick={() => removeId && removeMutation.mutate(removeId)}
          >
            Remove
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
}
