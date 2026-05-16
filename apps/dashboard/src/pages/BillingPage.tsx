import React, { useState } from 'react';
import { Check, Zap, Users, Building2, Download, CreditCard, HardDrive, Video } from 'lucide-react';
import { Button } from '@components/ui/Button';
import { Badge } from '@components/ui/Badge';
import { formatBytes, formatDate } from '@utils/index';
import * as Progress from '@radix-ui/react-progress';

type Plan = 'FREE' | 'PRO' | 'TEAM' | 'ENTERPRISE';

interface PlanConfig {
  name: string;
  price: string;
  period: string;
  icon: React.ReactNode;
  description: string;
  features: string[];
  cta: string;
  variant: 'secondary' | 'primary' | 'outline';
  popular?: boolean;
}

const PLANS: Record<Plan, PlanConfig> = {
  FREE: {
    name: 'Free',
    price: '$0',
    period: '/month',
    icon: <Zap className="h-5 w-5" />,
    description: 'Perfect for individuals just getting started',
    features: [
      '10 recordings/month',
      '2 GB storage',
      '720p quality',
      '7-day retention',
      'Public sharing',
    ],
    cta: 'Current plan',
    variant: 'secondary',
  },
  PRO: {
    name: 'Pro',
    price: '$12',
    period: '/month',
    icon: <Zap className="h-5 w-5 text-violet-400" />,
    description: 'For power users who need more',
    features: [
      'Unlimited recordings',
      '50 GB storage',
      '4K quality',
      'Forever retention',
      'Custom domain',
      'Password protection',
      'API access',
    ],
    cta: 'Upgrade to Pro',
    variant: 'primary',
    popular: true,
  },
  TEAM: {
    name: 'Team',
    price: '$49',
    period: '/month',
    icon: <Users className="h-5 w-5 text-blue-400" />,
    description: 'Collaborate with your whole team',
    features: [
      'Everything in Pro',
      '10 team seats',
      '500 GB storage',
      'Team workspace',
      'Role management',
      'SSO (SAML)',
      'Priority support',
    ],
    cta: 'Upgrade to Team',
    variant: 'outline',
  },
  ENTERPRISE: {
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    icon: <Building2 className="h-5 w-5 text-gray-400" />,
    description: 'For large organizations',
    features: [
      'Everything in Team',
      'Unlimited seats',
      'Unlimited storage',
      'Custom retention',
      'SLA guarantee',
      'Dedicated support',
      'Audit logs',
    ],
    cta: 'Contact sales',
    variant: 'secondary',
  },
};

const MOCK_INVOICES = [
  { id: 'inv_001', date: new Date('2024-03-01'), amount: 12.0, status: 'Paid', plan: 'Pro' },
  { id: 'inv_002', date: new Date('2024-02-01'), amount: 12.0, status: 'Paid', plan: 'Pro' },
  { id: 'inv_003', date: new Date('2024-01-01'), amount: 12.0, status: 'Paid', plan: 'Pro' },
  { id: 'inv_004', date: new Date('2023-12-01'), amount: 0.0, status: 'Free', plan: 'Free' },
];

const CURRENT_PLAN: Plan = 'PRO';
const STORAGE_USED = 12_800_000_000; // 12.8 GB
const STORAGE_TOTAL = 53_687_091_200; // 50 GB
const RECORDINGS_USED = 47;

export default function BillingPage() {
  const currentPlan = PLANS[CURRENT_PLAN];
  const storagePercent = Math.round((STORAGE_USED / STORAGE_TOTAL) * 100);

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-gray-100">Billing</h1>
        <p className="text-sm text-gray-500 mt-0.5">Manage your subscription and usage</p>
      </div>

      {/* ── Current plan ────────────────────────────────────────── */}
      <div className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-base font-semibold text-gray-200">Current plan</h2>
              <Badge variant="purple">{CURRENT_PLAN}</Badge>
            </div>
            <p className="text-sm text-gray-400">{currentPlan.description}</p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold text-gray-100">{currentPlan.price}</p>
            <p className="text-sm text-gray-500">{currentPlan.period}</p>
          </div>
        </div>

        {/* Usage meters */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Storage */}
          <div className="p-4 rounded-xl bg-gray-800/40 border border-white/[0.05] space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-gray-500" />
                <span className="text-sm font-medium text-gray-300">Storage</span>
              </div>
              <span className="text-xs text-gray-500">
                {formatBytes(STORAGE_USED)} / {formatBytes(STORAGE_TOTAL)}
              </span>
            </div>
            <Progress.Root
              className="h-2 bg-gray-700 rounded-full overflow-hidden"
              value={storagePercent}
            >
              <Progress.Indicator
                className="h-full bg-violet-500 rounded-full transition-all"
                style={{ width: `${storagePercent}%` }}
              />
            </Progress.Root>
            <p className="text-xs text-gray-500">{storagePercent}% used</p>
          </div>

          {/* Recordings */}
          <div className="p-4 rounded-xl bg-gray-800/40 border border-white/[0.05] space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Video className="h-4 w-4 text-gray-500" />
                <span className="text-sm font-medium text-gray-300">Recordings</span>
              </div>
              <span className="text-xs text-gray-500">Unlimited</span>
            </div>
            <Progress.Root className="h-2 bg-gray-700 rounded-full overflow-hidden" value={0}>
              <Progress.Indicator
                className="h-full bg-blue-500 rounded-full"
                style={{ width: '0%' }}
              />
            </Progress.Root>
            <p className="text-xs text-gray-500">{RECORDINGS_USED} total recordings</p>
          </div>
        </div>
      </div>

      {/* ── Plan comparison ──────────────────────────────────────── */}
      <div>
        <h2 className="text-base font-semibold text-gray-200 mb-4">Compare plans</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {(Object.entries(PLANS) as Array<[Plan, PlanConfig]>).map(([key, plan]) => {
            const isCurrent = key === CURRENT_PLAN;
            return (
              <div
                key={key}
                className={`card p-5 flex flex-col gap-4 relative ${
                  plan.popular ? 'border-violet-500/40 shadow-lg shadow-violet-500/20' : ''
                }`}
              >
                {plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge variant="purple">Most popular</Badge>
                  </div>
                )}

                <div>
                  <div className="flex items-center gap-2 mb-1">
                    {plan.icon}
                    <span className="font-semibold text-gray-200">{plan.name}</span>
                  </div>
                  <div className="flex items-baseline gap-0.5">
                    <span className="text-2xl font-bold text-gray-100">{plan.price}</span>
                    <span className="text-sm text-gray-500">{plan.period}</span>
                  </div>
                </div>

                <ul className="space-y-2 flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-xs text-gray-400">
                      <Check className="h-3.5 w-3.5 text-emerald-400 flex-shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>

                <Button
                  variant={isCurrent ? 'secondary' : plan.variant}
                  size="sm"
                  className="w-full"
                  disabled={isCurrent}
                  onClick={() => {
                    if (key === 'ENTERPRISE') {
                      window.open('mailto:sales@snaptrace.app', '_blank');
                    } else {
                      // Stripe checkout placeholder
                      console.log(`Upgrade to ${key}`);
                    }
                  }}
                >
                  {isCurrent ? 'Current plan' : plan.cta}
                </Button>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Billing history ──────────────────────────────────────── */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between p-5 border-b border-white/[0.06]">
          <h2 className="text-base font-semibold text-gray-200">Billing history</h2>
          <Button variant="ghost" size="sm" leftIcon={<Download className="h-3.5 w-3.5" />}>
            Download all
          </Button>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/[0.06]">
              {['Date', 'Plan', 'Amount', 'Status', ''].map((h) => (
                <th
                  key={h}
                  className="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {MOCK_INVOICES.map((inv) => (
              <tr key={inv.id} className="hover:bg-white/[0.02] transition-colors">
                <td className="px-5 py-3.5 text-gray-300">{formatDate(inv.date)}</td>
                <td className="px-5 py-3.5 text-gray-400">{inv.plan}</td>
                <td className="px-5 py-3.5 text-gray-300 font-medium">
                  {inv.amount === 0 ? '—' : `$${inv.amount.toFixed(2)}`}
                </td>
                <td className="px-5 py-3.5">
                  <Badge variant={inv.status === 'Paid' ? 'success' : 'default'} dot>
                    {inv.status}
                  </Badge>
                </td>
                <td className="px-5 py-3.5 text-right">
                  {inv.amount > 0 && (
                    <Button variant="ghost" size="xs" leftIcon={<Download className="h-3 w-3" />}>
                      Invoice
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Payment method */}
        <div className="p-5 border-t border-white/[0.06] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-gray-800">
              <CreditCard className="h-4 w-4 text-gray-400" />
            </div>
            <div>
              <p className="text-sm text-gray-300">Visa ending in 4242</p>
              <p className="text-xs text-gray-500">Expires 12/26</p>
            </div>
          </div>
          <Button variant="secondary" size="sm">
            Update payment method
          </Button>
        </div>
      </div>
    </div>
  );
}
